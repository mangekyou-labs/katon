package matcher

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

type ScaffoldConfig struct {
	TEEID string
	Key   []byte
	Now   uint64
	// Decrypt is the Weather-style node boundary. When present, the action
	// handler never receives an application private key and delegates all
	// ciphertext handling to this callback.
	Decrypt func(FccRecipientEnvelopeV1, string, uint64) ([]byte, error)
}

type ScaffoldAction struct {
	Data                       ScaffoldActionData `json:"data"`
	AdditionalVariableMessages []string           `json:"additionalVariableMessages"`
	Timestamps                 []uint64           `json:"timestamps"`
	AdditionalActionData       string             `json:"additionalActionData"`
	Signatures                 []string           `json:"signatures"`
}

type ScaffoldActionData struct {
	ID            string `json:"id"`
	Type          string `json:"type"`
	SubmissionTag string `json:"submissionTag"`
	Message       string `json:"message"`
}

type ScaffoldDataFixed struct {
	InstructionID          string   `json:"instructionId"`
	TEEID                  string   `json:"teeId"`
	Timestamp              uint64   `json:"timestamp"`
	RewardEpochID          uint32   `json:"rewardEpochId"`
	OPType                 string   `json:"opType"`
	OPCommand              string   `json:"opCommand"`
	Cosigners              []string `json:"cosigners"`
	CosignersThreshold     uint64   `json:"cosignersThreshold"`
	OriginalMessage        string   `json:"originalMessage"`
	AdditionalFixedMessage string   `json:"additionalFixedMessage"`
}

type ScaffoldActionResult struct {
	ID                     string   `json:"id"`
	SubmissionTag          string   `json:"submissionTag"`
	Status                 uint8    `json:"status"`
	Log                    string   `json:"log"`
	OPType                 string   `json:"opType"`
	OPCommand              string   `json:"opCommand"`
	AdditionalResultStatus string   `json:"additionalResultStatus"`
	Version                string   `json:"version"`
	Data                   HexBytes `json:"data"`
}

// HexBytes matches go-ethereum's hexutil.Bytes wire encoding used by the FCC
// scaffold: 0x-prefixed lowercase hex, including for empty byte slices.
type HexBytes []byte

func (value HexBytes) MarshalJSON() ([]byte, error) {
	return json.Marshal("0x" + hex.EncodeToString(value))
}

type scaffoldActionState struct {
	Result ScaffoldActionResult
}

type ScaffoldExtension struct {
	mu      sync.Mutex
	config  ScaffoldConfig
	actions map[string]scaffoldActionState
}

func NewScaffoldExtension(config ScaffoldConfig) *ScaffoldExtension {
	return &ScaffoldExtension{config: config, actions: make(map[string]scaffoldActionState)}
}

func (e *ScaffoldExtension) ProcessAction(action ScaffoldAction) (ScaffoldActionResult, int, error) {
	if err := validateScaffoldAction(action); err != nil {
		return ScaffoldActionResult{ID: action.Data.ID, SubmissionTag: action.Data.SubmissionTag, Status: 0, Log: "error: " + err.Error(), AdditionalResultStatus: "0x", Version: "0.1.0", Data: HexBytes{}}, 400, err
	}
	fixedBytes, err := decodeHexBytes(action.Data.Message)
	if err != nil {
		return ScaffoldActionResult{}, 400, errors.New("decoding fixed data")
	}
	var fixed ScaffoldDataFixed
	if err := decodeStrictBytes(fixedBytes, &fixed); err != nil {
		return ScaffoldActionResult{}, 400, errors.New("decoding fixed data")
	}
	if fixed.InstructionID != action.Data.ID {
		return ScaffoldActionResult{}, 400, errors.New("instruction id mismatch")
	}
	if !isKnownScaffoldOperation(fixed.OPType, fixed.OPCommand) {
		return ScaffoldActionResult{ID: action.Data.ID, SubmissionTag: action.Data.SubmissionTag, Status: 0, Log: "error: unsupported op type or command", OPType: fixed.OPType, OPCommand: fixed.OPCommand, AdditionalResultStatus: "0x", Version: "0.1.0", Data: HexBytes{}}, 501, errors.New("unsupported op type or command")
	}
	original, err := decodeHexBytes(fixed.OriginalMessage)
	if err != nil {
		return ScaffoldActionResult{}, 400, errors.New("original message is not hex")
	}
	envelope, err := ParseFccEnvelope(original)
	if err != nil {
		return e.failedResult(action, fixed, err)
	}
	if !fccHex32.MatchString(envelope.ActionID) || envelope.OPType != decodeIdentifier(fixed.OPType) || envelope.Command != decodeIdentifier(fixed.OPCommand) || envelope.Expiry < e.config.Now {
		return e.failedResult(action, fixed, errors.New("envelope metadata mismatch"))
	}
	var plaintext []byte
	if e.config.Decrypt != nil {
		plaintext, err = e.config.Decrypt(envelope, e.config.TEEID, e.config.Now)
	} else {
		plaintext, err = DecryptFccRecipient(envelope, e.config.TEEID, e.config.Key, e.config.Now)
	}
	if err != nil {
		return e.failedResult(action, fixed, err)
	}

	e.mu.Lock()
	if previous, ok := e.actions[action.Data.ID]; ok {
		e.mu.Unlock()
		return previous.Result, 200, nil
	}
	e.mu.Unlock()
	resultData, err := e.executeOperation(fixed.OPType, fixed.OPCommand, plaintext)
	if err != nil {
		return e.failedResult(action, fixed, err)
	}
	result := ScaffoldActionResult{
		ID: action.Data.ID, SubmissionTag: action.Data.SubmissionTag, Status: 1, Log: "ok",
		OPType: fixed.OPType, OPCommand: fixed.OPCommand, AdditionalResultStatus: "0x", Version: "0.1.0", Data: HexBytes(resultData),
	}
	e.mu.Lock()
	if previous, exists := e.actions[action.Data.ID]; exists {
		result = previous.Result
	} else {
		e.actions[action.Data.ID] = scaffoldActionState{Result: result}
	}
	e.mu.Unlock()
	return result, 200, nil
}

func (e *ScaffoldExtension) executeOperation(opType, opCommand string, plaintext []byte) ([]byte, error) {
	switch {
	case opType == bytes32Identifier(OpRFQ) && opCommand == bytes32Identifier(CommandCreate):
		var auction Auction
		if err := decodeStrictBytes(plaintext, &auction); err != nil || auction.Commitment == "" {
			return nil, errors.New("invalid RFQ create")
		}
		return json.Marshal(map[string]any{"commitment": auction.Commitment, "accepted": true})
	case opType == bytes32Identifier(OpBid) && opCommand == bytes32Identifier(CommandSubmit):
		var bid Bid
		if err := decodeStrictBytes(plaintext, &bid); err != nil || bid.Commitment == "" {
			return nil, errors.New("invalid BID submit")
		}
		return json.Marshal(map[string]any{"commitment": bid.Commitment, "accepted": true})
	case opType == bytes32Identifier(OpMatch) && opCommand == bytes32Identifier(CommandFinalize):
		var request FinalizeRequest
		if err := decodeStrictBytes(plaintext, &request); err != nil || request.RoutePlan == nil {
			return nil, errors.New("invalid MATCH finalize")
		}
		match, err := MatchAuction(request.Auction, request.Bids, request.Now, *request.RoutePlan)
		if err != nil {
			return nil, err
		}
		resultHash, err := decodeHexBytes(match.ResultHash)
		if err != nil || len(resultHash) != 32 {
			return nil, errors.New("invalid match result hash")
		}
		return resultHash, nil
	default:
		return nil, errors.New("unsupported op type or command")
	}
}

func (e *ScaffoldExtension) failedResult(action ScaffoldAction, fixed ScaffoldDataFixed, err error) (ScaffoldActionResult, int, error) {
	return ScaffoldActionResult{ID: action.Data.ID, SubmissionTag: action.Data.SubmissionTag, Status: 0, Log: "error: " + err.Error(), OPType: fixed.OPType, OPCommand: fixed.OPCommand, AdditionalResultStatus: "0x", Version: "0.1.0", Data: HexBytes{}}, 200, nil
}

func validateScaffoldAction(action ScaffoldAction) error {
	if action.Data.ID == "" || action.Data.Type == "" || action.Data.SubmissionTag == "" || action.Data.Message == "" {
		return errors.New("action fields required")
	}
	if len(action.Data.ID) != 66 || !strings.HasPrefix(action.Data.ID, "0x") {
		return errors.New("invalid action id")
	}
	if _, err := decodeHexBytes(action.Data.ID); err != nil {
		return errors.New("invalid action id")
	}
	return nil
}

func isKnownScaffoldOperation(opType, opCommand string) bool {
	return (opType == bytes32Identifier(OpRFQ) && opCommand == bytes32Identifier(CommandCreate)) ||
		(opType == bytes32Identifier(OpBid) && opCommand == bytes32Identifier(CommandSubmit)) ||
		(opType == bytes32Identifier(OpMatch) && opCommand == bytes32Identifier(CommandFinalize))
}

func bytes32Identifier(value string) string {
	encoded := make([]byte, 32)
	copy(encoded, []byte(value))
	return "0x" + fmt.Sprintf("%x", encoded)
}

func decodeIdentifier(value string) string {
	decoded, err := decodeHexBytes(value)
	if err != nil || len(decoded) != 32 {
		return ""
	}
	return strings.TrimRight(string(decoded), "\x00")
}

func decodeHexBytes(value string) ([]byte, error) {
	trimmed := strings.TrimPrefix(value, "0x")
	if len(trimmed)%2 != 0 {
		return nil, errors.New("hex length")
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

func decodeStrictBytes(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing input")
	}
	return nil
}

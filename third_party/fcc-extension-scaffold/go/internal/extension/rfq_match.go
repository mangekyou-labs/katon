package extension

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"extension-scaffold/internal/config"
	"extension-scaffold/internal/matcher"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// processMatch routes MATCH instructions by OPCommand.
func (e *Extension) processMatch(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandFinalize):
		ar := e.processMatchFinalize(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected [%s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandFinalize).Hex(), config.OPCommandFinalize,
		))
	}
}

// processMatchFinalize runs the deterministic auction: validate the finalize
// request, pick the winner, and return the canonical 32-byte route hash as
// ActionResult.Data. Idempotent per result: replays for the same auction
// recompute the same hash without double-counting.
func (e *Extension) processMatchFinalize(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var request matcher.FinalizeRequest
	if err := decodeStrict(df.OriginalMessage, &request); err != nil || request.RoutePlan == nil {
		return buildResult(action, df, nil, 0, errors.New("invalid MATCH finalize"))
	}

	match, err := matcher.MatchAuction(request.Auction, request.Bids, request.Now, *request.RoutePlan)
	if err != nil {
		return buildResult(action, df, nil, 0, err)
	}
	resultHash, err := hexToBytes(match.ResultHash)
	if err != nil || len(resultHash) != 32 {
		return buildResult(action, df, nil, 0, errors.New("invalid match result hash"))
	}

	e.mu.Lock()
	if e.lastResultHash != match.ResultHash {
		e.matchFinalizeCount++
	}
	e.lastResultHash = match.ResultHash
	e.mu.Unlock()

	return buildResult(action, df, resultHash, 1, nil)
}

// decodeStrict decodes JSON with DisallowUnknownFields and rejects trailing
// input — same semantics as matcher.DecodeAuction / scaffold_extension.go.
func decodeStrict(data []byte, target any) error {
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

func hexToBytes(value string) ([]byte, error) {
	trimmed := strings.TrimPrefix(value, "0x")
	decoded, err := hex.DecodeString(trimmed)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

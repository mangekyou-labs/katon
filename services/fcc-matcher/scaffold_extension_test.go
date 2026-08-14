package matcher

import (
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestScaffoldExtensionDecryptsAndProcessesMatch(t *testing.T) {
	key := bytesFilled(9)
	extension := NewScaffoldExtension(ScaffoldConfig{TEEID: "tee-a", Key: key, Now: 1700000000})
	metadata := FccEnvelopeMetadata{
		ChainID:     114,
		ExtensionID: "0x1111111111111111111111111111111111111111111111111111111111111111",
		ActionID:    "0x2222222222222222222222222222222222222222222222222222222222222222",
		OPType:      OpMatch,
		Command:     CommandFinalize,
		Expiry:      1800000000,
	}
	payload := FinalizeRequest{
		Auction: Auction{Commitment: "0x" + stringFilled('a', 64), ChainID: 114, Router: "0x" + stringFilled('b', 40), SellToken: "0x" + stringFilled('c', 40), BuyToken: "0x" + stringFilled('d', 40), SellAmount: "100", MinOutput: "100", DecisionDeadline: 1800000000},
		Bids:    []Bid{{Commitment: "bid", Bidder: "bidder", SellToken: "0x" + stringFilled('c', 40), BuyToken: "0x" + stringFilled('d', 40), SellAmount: "100", QuotedOutput: "101", Sequence: "1", ExpiresAt: 1800000000}},
		Now:     1700000000,
	}
	plaintext, _ := json.Marshal(payload)
	plan := SwapRoutePlan{ChainID: 114, Router: "0x" + stringFilled('b', 40), Commitment: "0x" + stringFilled('a', 64), FccActionID: metadata.ActionID, DecisionBlock: "1", DecisionBlockHash: "0x" + stringFilled('1', 64), Deadline: "1800000000", Seller: "0x" + stringFilled('2', 40), Recipient: "0x" + stringFilled('3', 40), SellToken: "0x" + stringFilled('c', 40), BuyToken: "0x" + stringFilled('d', 40), SellAmount: "100", MinOutput: "100", EligibilityPolicyID: "0x" + stringFilled('6', 64), EligibilityRevocationEpoch: "1", EligibilityRole: "1", EligibilityIssuerReference: "0x" + stringFilled('7', 64), Legs: []SwapRouteLeg{{Source: "0x" + stringFilled('8', 40), SellAmount: "100", MinOutput: "100", SourceData: "0x"}}}
	payload.RoutePlan = &plan
	plaintext, _ = json.Marshal(payload)
	envelope, err := EncryptFccEnvelope(plaintext, metadata, []FccEncryptionRecipient{{TEEID: "tee-a", KeyID: "key-a", PublicKey: mustPublicKey(t, key)}, {TEEID: "tee-b", KeyID: "key-b", PublicKey: mustPublicKey(t, bytesFilled(8))}, {TEEID: "tee-c", KeyID: "key-c", PublicKey: mustPublicKey(t, bytesFilled(7))}}, [][]byte{bytesFilledN(1, 12), bytesFilledN(2, 12), bytesFilledN(3, 12)})
	if err != nil {
		t.Fatal(err)
	}
	original, _ := CanonicalFccEnvelope(envelope)
	action := ScaffoldAction{Data: ScaffoldActionData{ID: metadata.ActionID, Type: "instruction", SubmissionTag: "submit", Message: "0x" + hex.EncodeToString(func() []byte {
		b, _ := json.Marshal(ScaffoldDataFixed{InstructionID: metadata.ActionID, TEEID: "0x" + stringFilled('9', 40), Timestamp: 1, RewardEpochID: 1, OPType: bytes32Identifier(OpMatch), OPCommand: bytes32Identifier(CommandFinalize), OriginalMessage: "0x" + hex.EncodeToString(original)})
		return b
	}())}}
	result, status, err := extension.ProcessAction(action)
	if err != nil || status != 200 {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if result.Status != 1 || result.Log != "ok" || len(result.Data) == 0 {
		t.Fatalf("result=%+v", result)
	}
	duplicate, _, err := extension.ProcessAction(action)
	if err != nil || string(duplicate.Data) != string(result.Data) {
		t.Fatalf("duplicate result mismatch: err=%v", err)
	}
}

func TestScaffoldExtensionRejectsUnsupportedAndWrongRecipient(t *testing.T) {
	extension := NewScaffoldExtension(ScaffoldConfig{TEEID: "tee-a", Key: bytesFilled(9), Now: 1700000000})
	action := ScaffoldAction{Data: ScaffoldActionData{ID: "0x" + stringFilled('2', 64), Message: "0x00"}}
	result, status, err := extension.ProcessAction(action)
	if err == nil || status != 400 || result.Status != 0 {
		t.Fatalf("expected unsupported operation: status=%d err=%v result=%+v", status, err, result)
	}
}

func stringFilled(value rune, length int) string {
	result := make([]rune, length)
	for index := range result {
		result[index] = value
	}
	return string(result)
}

package extension

import (
	"encoding/json"
	"net/http"
	"testing"

	"extension-scaffold/internal/config"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// The TrustRFQ confidential auction matcher operations are ported from
// services/fcc-matcher (deterministic core). The golden route hash below is
// the cross-language vector pinned by services/fcc-matcher/matcher_test.go
// (TestHashSwapRouteMatchesSolidityGoldenVector) and by the Solidity
// SwapRouteHashVector.t.sol Foundry test.
const goldenRouteHash = "0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975"

// goldenAuction mirrors the golden vector auction (chainId 114).
func goldenAuction() map[string]any {
	return map[string]any{
		"commitment":       "0x0000000000000000000000000000000000000000000000000000000000000011",
		"chainId":          114,
		"router":           "0x00000000000000000000000000000000000000aa",
		"sellToken":        "0x0000000000000000000000000000000000000010",
		"buyToken":         "0x0000000000000000000000000000000000000020",
		"sellAmount":       "100000000000000000000",
		"minOutput":        "95000000000000000000",
		"decisionDeadline": 2000,
	}
}

func goldenRoutePlan() map[string]any {
	return map[string]any{
		"chainId":                    114,
		"router":                     "0x00000000000000000000000000000000000000aa",
		"commitment":                 "0x0000000000000000000000000000000000000000000000000000000000000011",
		"fccActionId":                "0x0000000000000000000000000000000000000000000000000000000000000022",
		"decisionBlock":              "1234567",
		"decisionBlockHash":          "0x0000000000000000000000000000000000000000000000000000000000000033",
		"deadline":                   "2000000000",
		"seller":                     "0x00000000000000000000000000000000000000c1",
		"recipient":                  "0x00000000000000000000000000000000000000c2",
		"sellToken":                  "0x0000000000000000000000000000000000000010",
		"buyToken":                   "0x0000000000000000000000000000000000000020",
		"sellAmount":                 "100000000000000000000",
		"minOutput":                  "95000000000000000000",
		"protocolFeeBps":             50,
		"eligibilityPolicyId":        "0x0000000000000000000000000000000000000000000000000000000000000044",
		"eligibilityRevocationEpoch": "0",
		"eligibilityRole":            "1",
		"eligibilityIssuerReference": "0x0000000000000000000000000000000000000000000000000000000000000055",
		"legs": []map[string]any{{
			"source":     "0x00000000000000000000000000000000000000b1",
			"sellAmount": "100000000000000000000",
			"minOutput":  "95000000000000000000",
			"sourceData": "0x010203",
		}},
	}
}

func goldenBid() map[string]any {
	return map[string]any{
		"commitment":   "0x0000000000000000000000000000000000000000000000000000000000000099",
		"bidder":       "0x00000000000000000000000000000000000000b1",
		"sellToken":    "0x0000000000000000000000000000000000000010",
		"buyToken":     "0x0000000000000000000000000000000000000020",
		"sellAmount":   "100000000000000000000",
		"quotedOutput": "95000000000000000000",
		"sequence":     "1",
		"expiresAt":    2100,
	}
}

func marshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// actionResultJSON mirrors teetypes.ActionResult with Data kept as raw bytes
// so tests can assert exact hex payloads.
type actionResultJSON struct {
	ID            common.Hash      `json:"id"`
	SubmissionTag string           `json:"submissionTag"`
	Status        uint8            `json:"status"`
	Log           string           `json:"log"`
	Data          hexutil.Bytes    `json:"data"`
}


func TestProcessAction_RfqCreateAcceptsAuction(t *testing.T) {
	e := New(0, 0)
	action := buildTestAction(
		toHash(config.OPTypeRFQ),
		toHash(config.OPCommandCreate),
		marshal(t, goldenAuction()),
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result actionResultJSON
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Status != 1 {
		t.Fatalf("expected ActionResult.Status=1, got %d (log %q)", result.Status, result.Log)
	}
	var resp struct {
		Commitment string `json:"commitment"`
		Accepted   bool   `json:"accepted"`
	}
	if err := json.Unmarshal(result.Data, &resp); err != nil {
		t.Fatalf("decoding response data: %v (data %s)", err, result.Data)
	}
	if !resp.Accepted || resp.Commitment != "0x0000000000000000000000000000000000000000000000000000000000000011" {
		t.Fatalf("unexpected create response: %+v", resp)
	}
}

func TestProcessAction_BidSubmitAcceptsBid(t *testing.T) {
	e := New(0, 0)
	action := buildTestAction(
		toHash(config.OPTypeBid),
		toHash(config.OPCommandSubmit),
		marshal(t, goldenBid()),
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result actionResultJSON
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Status != 1 {
		t.Fatalf("expected ActionResult.Status=1, got %d (log %q)", result.Status, result.Log)
	}
	var resp struct {
		Commitment string `json:"commitment"`
		Accepted   bool   `json:"accepted"`
	}
	if err := json.Unmarshal(result.Data, &resp); err != nil {
		t.Fatalf("decoding response data: %v", err)
	}
	if !resp.Accepted {
		t.Fatalf("expected accepted=true, got %+v", resp)
	}
}

func TestProcessAction_MatchFinalizeReturnsGoldenRouteHash(t *testing.T) {
	e := New(0, 0)
	request := map[string]any{
		"auction":   goldenAuction(),
		"bids":      []map[string]any{goldenBid()},
		"now":       1000,
		"routePlan": goldenRoutePlan(),
	}
	action := buildTestAction(
		toHash(config.OPTypeMatch),
		toHash(config.OPCommandFinalize),
		marshal(t, request),
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result actionResultJSON
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Status != 1 {
		t.Fatalf("expected ActionResult.Status=1, got %d (log %q)", result.Status, result.Log)
	}
	if hex := common.BytesToHash(result.Data).Hex(); hex != goldenRouteHash {
		t.Fatalf("route hash mismatch:\n got %s\nwant %s", hex, goldenRouteHash)
	}
}

func TestProcessAction_MatchFinalizeReplayIsIdempotent(t *testing.T) {
	e := New(0, 0)
	request := map[string]any{
		"auction":   goldenAuction(),
		"bids":      []map[string]any{goldenBid()},
		"now":       1000,
		"routePlan": goldenRoutePlan(),
	}
	action := buildTestAction(
		toHash(config.OPTypeMatch),
		toHash(config.OPCommandFinalize),
		marshal(t, request),
	)

	_, first := e.processAction(action)
	_, second := e.processAction(action)

	if string(first) != string(second) {
		t.Fatalf("replayed instruction returned different bytes:\nfirst  %s\nsecond %s", first, second)
	}
	if e.matchFinalizeCount != 1 {
		t.Fatalf("expected matchFinalizeCount=1 after replay, got %d", e.matchFinalizeCount)
	}
}
func TestProcessAction_RfqUnknownCommandIs501(t *testing.T) {
	e := New(0, 0)
	action := buildTestAction(
		toHash(config.OPTypeRFQ),
		toHash("SUBMIT"),
		marshal(t, goldenAuction()),
	)

	status, body := e.processAction(action)
	if status != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotImplemented, status, body)
	}
	if !contains(string(body), "unsupported op command") {
		t.Fatalf("expected 'unsupported op command', got %s", body)
	}
}

func TestProcessAction_RfqCreateRejectsUnknownFields(t *testing.T) {
	e := New(0, 0)
	payload := marshal(t, goldenAuction())
	payload = append(payload[:len(payload)-1], []byte(`,"extra":"field"}`)...)

	action := buildTestAction(
		toHash(config.OPTypeRFQ),
		toHash(config.OPCommandCreate),
		payload,
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result actionResultJSON
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 for unknown field, got %d", result.Status)
	}
	if !contains(result.Log, "invalid RFQ create") {
		t.Fatalf("expected 'invalid RFQ create' log, got %q", result.Log)
	}
}

func TestProcessAction_StateTracksMatcherOperations(t *testing.T) {
	e := New(0, 0)

	if _, body := e.processAction(buildTestAction(
		toHash(config.OPTypeRFQ), toHash(config.OPCommandCreate), marshal(t, goldenAuction()),
	)); string(body) == "" {
		t.Fatal("empty create body")
	}
	if _, body := e.processAction(buildTestAction(
		toHash(config.OPTypeBid), toHash(config.OPCommandSubmit), marshal(t, goldenBid()),
	)); string(body) == "" {
		t.Fatal("empty submit body")
	}
	request := map[string]any{
		"auction":   goldenAuction(),
		"bids":      []map[string]any{goldenBid()},
		"now":       1000,
		"routePlan": goldenRoutePlan(),
	}
	if _, body := e.processAction(buildTestAction(
		toHash(config.OPTypeMatch), toHash(config.OPCommandFinalize), marshal(t, request),
	)); string(body) == "" {
		t.Fatal("empty finalize body")
	}

	state := e.currentState()
	if state.RfqCreateCount != 1 || state.BidSubmitCount != 1 || state.MatchFinalizeCount != 1 {
		t.Fatalf("unexpected counts: %+v", state)
	}
	if state.LastResultHash != goldenRouteHash {
		t.Fatalf("expected lastResultHash %s, got %s", goldenRouteHash, state.LastResultHash)
	}
}


func TestProcessAction_MatchFinalizeMissingRoutePlanFails(t *testing.T) {
	e := New(0, 0)
	request := map[string]any{
		"auction": goldenAuction(),
		"bids":    []map[string]any{goldenBid()},
		"now":     1000,
	}
	action := buildTestAction(
		toHash(config.OPTypeMatch),
		toHash(config.OPCommandFinalize),
		marshal(t, request),
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result actionResultJSON
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0, got %d", result.Status)
	}
	if !contains(result.Log, "invalid MATCH finalize") {
		t.Fatalf("expected 'invalid MATCH finalize' log, got %q", result.Log)
	}
}

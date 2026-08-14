package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHealthAndMethodBoundary(t *testing.T) {
	server := newTestServer(httpHandler())
	defer server.Close()

	response, err := server.Client().Get(server.URL + "/readyz")
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("health failed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()

	response, err = server.Client().Get(server.URL + "/ready")
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("FCC ready compatibility failed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()

	response, err = server.Client().Post(server.URL+"/healthz", "application/json", strings.NewReader("{}"))
	if err != nil || response.StatusCode != 405 {
		t.Fatalf("method boundary failed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestMatchRejectsUnknownFieldsAndReturnsWinner(t *testing.T) {
	server := newTestServer(httpHandler())
	defer server.Close()

	payload := `{"auction":{"commitment":"0x0000000000000000000000000000000000000000000000000000000000000011","chainId":114,"router":"0x00000000000000000000000000000000000000aa","sellToken":"0x0000000000000000000000000000000000000010","buyToken":"0x0000000000000000000000000000000000000020","sellAmount":"100","minOutput":"90","decisionDeadline":2000},"bids":[{"commitment":"0xb","bidder":"lp","sellToken":"0x0000000000000000000000000000000000000010","buyToken":"0x0000000000000000000000000000000000000020","sellAmount":"100","quotedOutput":"100","sequence":"1","expiresAt":2100}],"now":1000,"routePlan":{"chainId":114,"router":"0x00000000000000000000000000000000000000aa","commitment":"0x0000000000000000000000000000000000000000000000000000000000000011","fccActionId":"0x0000000000000000000000000000000000000000000000000000000000000022","decisionBlock":"1234567","decisionBlockHash":"0x0000000000000000000000000000000000000000000000000000000000000033","deadline":"2000000000","seller":"0x00000000000000000000000000000000000000c1","recipient":"0x00000000000000000000000000000000000000c2","sellToken":"0x0000000000000000000000000000000000000010","buyToken":"0x0000000000000000000000000000000000000020","sellAmount":"100","minOutput":"90","protocolFeeBps":50,"eligibilityPolicyId":"0x0000000000000000000000000000000000000000000000000000000000000044","eligibilityRevocationEpoch":"0","eligibilityRole":"1","eligibilityIssuerReference":"0x0000000000000000000000000000000000000000000000000000000000000055","legs":[{"source":"0x00000000000000000000000000000000000000b1","sellAmount":"100","minOutput":"90","sourceData":"0x010203"}]}}`
	response, err := server.Client().Post(server.URL+"/v1/match", "application/json", strings.NewReader(payload))
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("match failed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()

	unknown := strings.Replace(payload, `"now":1000`, `"now":1000,"privateKey":"secret"`, 1)
	response, err = server.Client().Post(server.URL+"/v1/match", "application/json", strings.NewReader(unknown))
	if err != nil || response.StatusCode != 400 {
		t.Fatalf("unknown field was accepted: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestQuorumReturnsSafeUnavailableError(t *testing.T) {
	server := newTestServer(httpHandler())
	defer server.Close()
	payload := `{"results":[{"resultHash":"0x1","teeId":"a","attested":true},{"resultHash":"0x2","teeId":"b","attested":true}],"threshold":2}`
	response, err := server.Client().Post(server.URL+"/v1/quorum", "application/json", strings.NewReader(payload))
	if err != nil || response.StatusCode != 422 {
		t.Fatalf("quorum boundary failed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestOperationAllowlistIncludesTypedLiquidationAndRejectsUnknown(t *testing.T) {
	server := newTestServer(httpHandler())
	defer server.Close()
	response, err := server.Client().Post(server.URL+"/v1/operation", "application/json", strings.NewReader(`{"opType":"LIQUIDATION","command":"FINALIZE"}`))
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("liquidation operation rejected: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
	response, err = server.Client().Post(server.URL+"/v1/operation", "application/json", strings.NewReader(`{"opType":"LIQUIDATION","command":"UNKNOWN"}`))
	if err != nil || response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unknown operation accepted: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestTypesReturnsStableOperationRegistry(t *testing.T) {
	server := newTestServer(httpHandler())
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/v1/types")
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("type registry failed: %v status=%d", err, response.StatusCode)
	}
	defer response.Body.Close()
	var body struct {
		Operations []struct {
			OpType   string   `json:"opType"`
			Commands []string `json:"commands"`
		} `json:"operations"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Operations) != 4 || body.Operations[3].OpType != "LIQUIDATION" ||
		!slices.Contains(body.Operations[3].Commands, "FINALIZE") {
		t.Fatalf("unexpected type registry: %#v", body)
	}
}

func TestActionIngressAcceptsCommitmentOnlyInstructionAndRejectsPlaintextFields(t *testing.T) {
	server := newTestServer(httpHandler())
	defer server.Close()
	valid := `{"opType":"LIQUIDATION","command":"FINALIZE","actionId":"0x01","payloadCommitment":"0x02","ciphertextUrl":"https://relay.example/object/1","ciphertextDigest":"0x` + strings.Repeat("a", 64) + `","expiry":2000}`
	response, err := server.Client().Post(server.URL+"/v1/action", "application/json", strings.NewReader(valid))
	if err != nil || response.StatusCode != http.StatusAccepted {
		t.Fatalf("valid action rejected: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
	plaintext := strings.Replace(valid, `,"expiry":2000`, `,"plaintext":"secret","expiry":2000`, 1)
	response, err = server.Client().Post(server.URL+"/v1/action", "application/json", strings.NewReader(plaintext))
	if err != nil || response.StatusCode != http.StatusBadRequest {
		t.Fatalf("plaintext action accepted: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestInstructionProxyFailsClosedWhenTEEIsUnconfigured(t *testing.T) {
	t.Setenv("FCC_EXTENSION_TEE_URL", "")
	response := httptest.NewRecorder()
	proxyToExtension(response, httptest.NewRequest(http.MethodPost, "/instruction", strings.NewReader(`{}`)))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "FCC_EXTENSION_TEE_UNCONFIGURED") {
		t.Fatalf("unexpected proxy response: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRealModeFailsClosedUntilAttestationIsConfigured(t *testing.T) {
	t.Setenv("FCC_MATCHER_MODE", "real")
	server := newTestServer(httpHandler())
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/readyz")
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("real readiness did not fail closed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
	response, err = server.Client().Post(server.URL+"/v1/match", "application/json", strings.NewReader("{}"))
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("real matcher did not fail closed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestRealModeRequiresThreeDistinctAttestedMachines(t *testing.T) {
	servers := make([]*httptest.Server, 0, 3)
	for _, teeID := range []string{"tee-a", "tee-b", "tee-c"} {
		teeID := teeID
		servers = append(servers, newTestServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/info" {
				http.NotFound(response, request)
				return
			}
			_, _ = response.Write([]byte(`{"machineData":{"codeHash":"0xabc","extensionId":"65536","teeId":"` + teeID + `","owner":"0xowner","platformMeasurement":"0xmeasurement","simulatedTee":false}}`))
		})))
	}
	defer func() {
		for _, server := range servers {
			server.Close()
		}
	}()
	urls := make([]string, 0, len(servers))
	for _, server := range servers {
		urls = append(urls, server.URL)
	}
	t.Setenv("FCC_MATCHER_MODE", "real")
	t.Setenv("FCC_MATCHER_ATTESTATION_URLS", strings.Join(urls, ","))
	t.Setenv("FCC_MATCHER_CODE_HASH", "abc")
	t.Setenv("FCC_MATCHER_EXTENSION_ID", "0x10000")
	t.Setenv("FCC_MATCHER_OWNER", "0xowner")
	t.Setenv("FCC_MATCHER_PLATFORM_MEASUREMENT", "0xmeasurement")
	t.Setenv("FCC_MATCHER_REQUIRED_TEE_IDS", "tee-a,tee-b,tee-c")
	t.Setenv("FCC_MATCHER_ATTESTATION_TTL", "1ms")
	server := newTestServer(httpHandler())
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/readyz")
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("real readiness failed: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()

	servers[2].Config.Handler = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"machineData":{"codeHash":"0xabc","extensionId":"65536","teeId":"tee-a","simulatedTee":false}}`))
	})
	time.Sleep(2 * time.Millisecond)
	response, err = server.Client().Get(server.URL + "/readyz")
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("duplicate TEE identity accepted: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func TestRealModeRejectsDuplicateAttestationEndpoints(t *testing.T) {
	server := newTestServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"machineData":{"codeHash":"0xabc","extensionId":"65536","teeId":"tee-a","simulatedTee":false}}`))
	}))
	defer server.Close()
	t.Setenv("FCC_MATCHER_MODE", "real")
	t.Setenv("FCC_MATCHER_ATTESTATION_URLS", strings.Join([]string{server.URL, server.URL, server.URL}, ","))
	t.Setenv("FCC_MATCHER_CODE_HASH", "abc")
	t.Setenv("FCC_MATCHER_EXTENSION_ID", "0x10000")
	t.Setenv("FCC_MATCHER_REQUIRED_TEE_IDS", "tee-a,tee-b,tee-c")
	response, err := http.DefaultClient.Get(server.URL + "/unused")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if summary := verifyRealAttestation(t.Context()); summary.Error != "FCC_ATTESTATION_ENDPOINT_DUPLICATE" {
		t.Fatalf("duplicate endpoints were accepted: %#v", summary)
	}
}

func TestRealModeRejectsOwnerOrPlatformMeasurementMismatch(t *testing.T) {
	servers := make([]*httptest.Server, 0, 3)
	for _, teeID := range []string{"tee-a", "tee-b", "tee-c"} {
		teeID := teeID
		servers = append(servers, newTestServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			_, _ = response.Write([]byte(`{"machineData":{"codeHash":"0xabc","extensionId":"65536","teeId":"` + teeID + `","owner":"0xother","platformMeasurement":"0xmeasurement","simulatedTee":false}}`))
		})))
	}
	defer func() {
		for _, server := range servers {
			server.Close()
		}
	}()
	urls := make([]string, 0, len(servers))
	for _, server := range servers {
		urls = append(urls, server.URL)
	}
	t.Setenv("FCC_MATCHER_MODE", "real")
	t.Setenv("FCC_MATCHER_ATTESTATION_URLS", strings.Join(urls, ","))
	t.Setenv("FCC_MATCHER_CODE_HASH", "abc")
	t.Setenv("FCC_MATCHER_EXTENSION_ID", "0x10000")
	t.Setenv("FCC_MATCHER_OWNER", "0xowner")
	t.Setenv("FCC_MATCHER_PLATFORM_MEASUREMENT", "0xmeasurement")
	t.Setenv("FCC_MATCHER_REQUIRED_TEE_IDS", "tee-a,tee-b,tee-c")
	t.Setenv("FCC_MATCHER_ATTESTATION_TTL", "1ms")
	server := newTestServer(httpHandler())
	defer server.Close()
	time.Sleep(2 * time.Millisecond)
	response, err := server.Client().Get(server.URL + "/readyz")
	if err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("owner mismatch accepted: %v status=%d", err, response.StatusCode)
	}
	response.Body.Close()
}

func httpHandler() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", health)
	mux.HandleFunc("/readyz", health)
	mux.HandleFunc("/ready", health)
	mux.HandleFunc("/v1/match", match)
	mux.HandleFunc("/v1/quorum", quorum)
	mux.HandleFunc("/v1/operation", operation)
	mux.HandleFunc("/v1/action", action)
	mux.HandleFunc("/v1/types", types)
	return mux
}

func newTestServer(handler http.Handler) *httptest.Server {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener
	server.Start()
	return server
}

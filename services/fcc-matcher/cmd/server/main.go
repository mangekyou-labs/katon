package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	matcher "github.com/trustrfq/flare-confidential-rfq/services/fcc-matcher"
)

const maxRequestBytes = 256 * 1024

type matchRequest struct {
	Auction   matcher.Auction        `json:"auction"`
	Bids      []matcher.Bid          `json:"bids"`
	Now       int64                  `json:"now"`
	RoutePlan *matcher.SwapRoutePlan `json:"routePlan"`
}

type quorumRequest struct {
	Results   []matcher.TEEResult `json:"results"`
	Threshold int                 `json:"threshold"`
}

type operationRequest struct {
	OpType  string `json:"opType"`
	Command string `json:"command"`
}

type actionRequest struct {
	OpType            string `json:"opType"`
	Command           string `json:"command"`
	ActionID          string `json:"actionId"`
	PayloadCommitment string `json:"payloadCommitment"`
	CiphertextURL     string `json:"ciphertextUrl"`
	CiphertextDigest  string `json:"ciphertextDigest"`
	Expiry            int64  `json:"expiry"`
}

var ciphertextDigestPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

type safeError struct {
	Error string `json:"error"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		runHealthcheck()
		return
	}
	port := os.Getenv("FCC_MATCHER_PORT")
	if port == "" {
		port = "8090"
	}
	if _, err := strconv.Atoi(port); err != nil {
		log.Fatal("FCC_MATCHER_PORT must be numeric")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", health)
	mux.HandleFunc("/readyz", health)
	mux.HandleFunc("/ready", health)
	mux.HandleFunc("/v1/match", match)
	mux.HandleFunc("/v1/quorum", quorum)
	mux.HandleFunc("/v1/operation", operation)
	mux.HandleFunc("/v1/action", action)
	mux.HandleFunc("/v1/types", types)
	weatherExtension := matcher.NewWeatherExtensionFromEnv()
	if os.Getenv("FCC_SERVICE_ROLE") == "ext-proxy" {
		mux.HandleFunc("/info", proxyToExtension)
		mux.HandleFunc("/state", proxyToExtension)
		mux.HandleFunc("/action/status/", proxyToExtension)
		mux.HandleFunc("/instruction", proxyToExtension)
	} else {
		mux.Handle("/info", weatherExtension)
		mux.Handle("/state", weatherExtension)
		mux.Handle("/action", weatherExtension)
		mux.Handle("/action/status/", weatherExtension)
		mux.Handle("/instruction", weatherExtension)
		mux.Handle("/decrypt", weatherExtension)
	}
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-shutdown
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("FCC matcher shutdown failed: %v", err)
		}
	}()
	log.Printf("FCC matcher listening on :%s", port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// proxyToExtension models the official ext-proxy boundary: providers POST the
// cosigned instruction to this process, and the proxy forwards it to the
// extension TEE. The proxy never decrypts or discovers instructions from an
// indexer.
func proxyToExtension(response http.ResponseWriter, request *http.Request) {
	target := strings.TrimRight(os.Getenv("FCC_EXTENSION_TEE_URL"), "/")
	if target == "" {
		writeError(response, http.StatusServiceUnavailable, "FCC_EXTENSION_TEE_UNCONFIGURED")
		return
	}
	path := request.URL.Path
	if path == "/instruction" {
		path = "/action"
	}
	upstream, err := http.NewRequestWithContext(request.Context(), request.Method, target+path, http.MaxBytesReader(response, request.Body, maxRequestBytes))
	if err != nil {
		writeError(response, http.StatusBadGateway, "FCC_EXTENSION_TEE_REQUEST")
		return
	}
	upstream.Header.Set("content-type", request.Header.Get("content-type"))
	client := &http.Client{Timeout: 15 * time.Second}
	result, err := client.Do(upstream)
	if err != nil {
		writeError(response, http.StatusBadGateway, "FCC_EXTENSION_TEE_UNAVAILABLE")
		return
	}
	defer result.Body.Close()
	for key, values := range result.Header {
		for _, value := range values {
			response.Header().Add(key, value)
		}
	}
	response.WriteHeader(result.StatusCode)
	_, _ = io.Copy(response, io.LimitReader(result.Body, maxRequestBytes))
}

// runHealthcheck is invoked by the distroless container's HEALTHCHECK command.
// It probes the already-running server rather than starting a second listener.
func runHealthcheck() {
	port := os.Getenv("FCC_MATCHER_PORT")
	if port == "" {
		port = "8090"
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/readyz")
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		os.Exit(1)
	}
}

func health(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	mode, err := configuredMode()
	if err != nil {
		writeError(response, http.StatusInternalServerError, err.Error())
		return
	}
	status := http.StatusOK
	body := map[string]any{"ok": true, "service": "fcc-matcher", "mode": mode}
	if mode == "real" {
		summary := verifyRealAttestation(request.Context())
		body["attestation"] = summary
		if request.URL.Path == "/readyz" && !summary.OK {
			status = http.StatusServiceUnavailable
			body["ok"] = false
		}
	}
	writeJSON(response, status, body)
}

func match(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if !matcherAvailable(response, request.Context()) {
		return
	}
	var input matchRequest
	if err := decodeStrict(response, request, &input); err != nil {
		return
	}
	if input.RoutePlan == nil {
		writeError(response, http.StatusBadRequest, "ROUTE_PLAN_REQUIRED")
		return
	}
	result, err := matcher.MatchAuction(input.Auction, input.Bids, input.Now, *input.RoutePlan)
	if err != nil {
		writeMatcherError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func quorum(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if !matcherAvailable(response, request.Context()) {
		return
	}
	var input quorumRequest
	if err := decodeStrict(response, request, &input); err != nil {
		return
	}
	result, err := matcher.VerifyQuorum(input.Results, input.Threshold)
	if err != nil {
		writeMatcherError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func operation(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if !matcherAvailable(response, request.Context()) {
		return
	}
	var input operationRequest
	if err := decodeStrict(response, request, &input); err != nil {
		return
	}
	if !matcher.AllowedOperation(input.OpType, input.Command) {
		writeError(response, http.StatusUnprocessableEntity, "OP_NOT_ALLOWED")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"allowed": true, "opType": input.OpType, "command": input.Command})
}

func action(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if !matcherAvailable(response, request.Context()) {
		return
	}
	var input actionRequest
	if err := decodeStrict(response, request, &input); err != nil {
		return
	}
	if !matcher.AllowedOperation(input.OpType, input.Command) ||
		input.ActionID == "" || input.PayloadCommitment == "" || input.Expiry <= 0 ||
		!ciphertextDigestPattern.MatchString(input.CiphertextDigest) {
		writeError(response, http.StatusBadRequest, "ACTION_INVALID")
		return
	}
	ciphertextURL, err := url.Parse(input.CiphertextURL)
	if err != nil || ciphertextURL.Scheme != "https" || ciphertextURL.Hostname() == "" || ciphertextURL.User != nil {
		writeError(response, http.StatusBadRequest, "ACTION_INVALID")
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{
		"accepted": true,
		"actionId": input.ActionID,
		"opType":   input.OpType,
		"command":  input.Command,
	})
}

func types(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"version": "1",
		"operations": []map[string]any{
			{"opType": matcher.OpRFQ, "commands": []string{matcher.CommandCreate, matcher.CommandCancel}},
			{"opType": matcher.OpBid, "commands": []string{matcher.CommandSubmit, matcher.CommandStanding}},
			{"opType": matcher.OpMatch, "commands": []string{matcher.CommandQuote, matcher.CommandFinalize}},
			{"opType": matcher.OpLiquidation, "commands": []string{matcher.CommandCreate, matcher.CommandFinalize}},
		},
	})
}

func decodeStrict(response http.ResponseWriter, request *http.Request, target any) error {
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(response, http.StatusBadRequest, "REQUEST_INVALID")
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "REQUEST_INVALID")
		if err == nil {
			return errors.New("TRAILING_INPUT")
		}
		return err
	}
	return nil
}

func writeMatcherError(response http.ResponseWriter, err error) {
	status := http.StatusUnprocessableEntity
	if errors.Is(err, matcher.ErrAuctionInput) || errors.Is(err, matcher.ErrBidInput) {
		status = http.StatusBadRequest
	}
	writeError(response, status, err.Error())
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, safeError{Error: code})
}

func configuredMode() (string, error) {
	mode := os.Getenv("FCC_MATCHER_MODE")
	if mode == "" || mode == "simulated" {
		return "simulated", nil
	}
	if mode == "real" {
		return mode, nil
	}
	return "", errors.New("FCC_MATCHER_MODE_INVALID")
}

func matcherAvailable(response http.ResponseWriter, ctx context.Context) bool {
	mode, err := configuredMode()
	if err != nil {
		writeError(response, http.StatusInternalServerError, err.Error())
		return false
	}
	if mode == "real" {
		summary := verifyRealAttestation(ctx)
		if !summary.OK {
			writeError(response, http.StatusServiceUnavailable, summary.Error)
			return false
		}
	}
	return true
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("content-type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

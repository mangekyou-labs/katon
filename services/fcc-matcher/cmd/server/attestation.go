package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultAttestationTimeout = 5 * time.Second
	defaultAttestationTTL     = 30 * time.Second
)

type attestationSummary struct {
	OK       bool   `json:"ok"`
	TEECount int    `json:"teeCount"`
	Checked  string `json:"checkedAt,omitempty"`
	Error    string `json:"error,omitempty"`
}

type attestationVerifier struct {
	mu          sync.Mutex
	fingerprint string
	expiresAt   time.Time
	summary     attestationSummary
	client      *http.Client
}

var realAttestation = &attestationVerifier{}

func verifyRealAttestation(ctx context.Context) attestationSummary {
	urls, expectedCodeHash, expectedExtensionID, requiredTEEIDs, timeout, ttl, err := attestationConfig()
	if err != nil {
		return attestationSummary{Error: err.Error()}
	}
	fingerprint := strings.Join(append(append(urls, expectedCodeHash, expectedExtensionID), requiredTEEIDs...), "|")
	now := time.Now()
	realAttestation.mu.Lock()
	if realAttestation.fingerprint == fingerprint && now.Before(realAttestation.expiresAt) {
		summary := realAttestation.summary
		realAttestation.mu.Unlock()
		return summary
	}
	if realAttestation.client == nil || realAttestation.client.Timeout != timeout {
		realAttestation.client = &http.Client{Timeout: timeout}
	}
	client := realAttestation.client
	realAttestation.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpointSeen := make(map[string]struct{}, len(urls))
	seen := make(map[string]struct{}, len(urls))
	for _, endpoint := range urls {
		endpointKey := strings.ToLower(strings.TrimRight(strings.TrimSpace(endpoint), "/"))
		if _, duplicate := endpointSeen[endpointKey]; duplicate {
			return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_ENDPOINT_DUPLICATE"))
		}
		endpointSeen[endpointKey] = struct{}{}
		info, fetchErr := fetchAttestationInfo(ctx, client, endpoint)
		if fetchErr != nil {
			return realAttestationFailure(fingerprint, ttl, fetchErr)
		}
		codeHash, ok := findString(info, "codeHash", "code_hash")
		if !ok || !sameHex(codeHash, expectedCodeHash) {
			return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_CODE_HASH_MISMATCH"))
		}
		extensionID, ok := findScalar(info, "extensionId", "extensionID", "extension_id")
		if !ok || !sameScalar(extensionID, expectedExtensionID) {
			return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_EXTENSION_MISMATCH"))
		}
		if isSimulated(info) {
			return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_SIMULATED"))
		}
		if expectedOwner := strings.TrimSpace(os.Getenv("FCC_MATCHER_OWNER")); expectedOwner != "" {
			owner, ownerOK := findString(info, "owner", "initialOwner", "initial_owner")
			if !ownerOK || !sameHex(owner, expectedOwner) && !strings.EqualFold(owner, expectedOwner) {
				return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_OWNER_MISMATCH"))
			}
		}
		if expectedMeasurement := strings.TrimSpace(os.Getenv("FCC_MATCHER_PLATFORM_MEASUREMENT")); expectedMeasurement != "" {
			measurement, measurementOK := findString(info, "platformMeasurement", "platform_measurement", "measurement", "codeMeasurement")
			if !measurementOK || !sameHex(measurement, expectedMeasurement) && !strings.EqualFold(measurement, expectedMeasurement) {
				return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_MEASUREMENT_MISMATCH"))
			}
		}
		teeID, ok := findString(info, "teeId", "teeID", "tee_id", "machineId", "machineID", "machine_id")
		if !ok || !containsFold(requiredTEEIDs, teeID) {
			return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_TEE_ID_MISMATCH"))
		}
		key := strings.ToLower(strings.TrimSpace(teeID))
		if _, duplicate := seen[key]; duplicate {
			return realAttestationFailure(fingerprint, ttl, errors.New("FCC_ATTESTATION_TEE_ID_DUPLICATE"))
		}
		seen[key] = struct{}{}
	}
	summary := attestationSummary{OK: true, TEECount: len(seen), Checked: now.UTC().Format(time.RFC3339)}
	cacheAttestation(fingerprint, ttl, summary)
	return summary
}

func attestationConfig() ([]string, string, string, []string, time.Duration, time.Duration, error) {
	rawURLs := os.Getenv("FCC_MATCHER_ATTESTATION_URLS")
	if rawURLs == "" {
		rawURLs = os.Getenv("FCC_MATCHER_ATTESTATION_URL")
	}
	urls := splitCSV(rawURLs)
	if len(urls) != 3 {
		return nil, "", "", nil, 0, 0, errors.New("FCC_ATTESTATION_REQUIRES_THREE_ENDPOINTS")
	}
	codeHash := strings.TrimSpace(os.Getenv("FCC_MATCHER_CODE_HASH"))
	extensionID := strings.TrimSpace(os.Getenv("FCC_MATCHER_EXTENSION_ID"))
	if codeHash == "" || extensionID == "" {
		return nil, "", "", nil, 0, 0, errors.New("FCC_ATTESTATION_EXPECTED_IDENTITY_MISSING")
	}
	teeIDs := splitCSV(os.Getenv("FCC_MATCHER_REQUIRED_TEE_IDS"))
	if len(teeIDs) != 3 || uniqueFold(teeIDs) != 3 {
		return nil, "", "", nil, 0, 0, errors.New("FCC_ATTESTATION_REQUIRES_THREE_TEE_IDS")
	}
	timeout := durationEnv("FCC_MATCHER_ATTESTATION_TIMEOUT", defaultAttestationTimeout)
	ttl := durationEnv("FCC_MATCHER_ATTESTATION_TTL", defaultAttestationTTL)
	return urls, codeHash, extensionID, teeIDs, timeout, ttl, nil
}

func fetchAttestationInfo(ctx context.Context, client *http.Client, endpoint string) (map[string]any, error) {
	endpoint = strings.TrimRight(endpoint, "/")
	if !strings.HasSuffix(endpoint, "/info") {
		endpoint += "/info"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errors.New("FCC_ATTESTATION_ENDPOINT_INVALID")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("FCC_ATTESTATION_ENDPOINT_UNAVAILABLE")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("FCC_ATTESTATION_ENDPOINT_NOT_READY")
	}
	var payload map[string]any
	decoder := json.NewDecoder(io.LimitReader(response.Body, 64*1024))
	if err := decoder.Decode(&payload); err != nil {
		return nil, errors.New("FCC_ATTESTATION_RESPONSE_INVALID")
	}
	return payload, nil
}

func findString(payload map[string]any, keys ...string) (string, bool) {
	value, ok := findValue(payload, keys...)
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	return strings.TrimSpace(text), ok && strings.TrimSpace(text) != ""
}

func findScalar(payload map[string]any, keys ...string) (string, bool) {
	value, ok := findValue(payload, keys...)
	if !ok {
		return "", false
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed), strings.TrimSpace(typed) != ""
	case float64:
		return strconv.FormatUint(uint64(typed), 10), typed >= 0 && typed == float64(uint64(typed))
	default:
		return fmt.Sprint(typed), true
	}
}

func findValue(payload map[string]any, keys ...string) (any, bool) {
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[strings.ToLower(key)] = struct{}{}
	}
	var walk func(map[string]any) (any, bool)
	walk = func(current map[string]any) (any, bool) {
		for key, value := range current {
			if _, ok := wanted[strings.ToLower(key)]; ok {
				return value, true
			}
		}
		for _, value := range current {
			if child, ok := value.(map[string]any); ok {
				if found, exists := walk(child); exists {
					return found, true
				}
			}
		}
		return nil, false
	}
	return walk(payload)
}

func isSimulated(payload map[string]any) bool {
	for _, key := range []string{"simulated", "simulatedTee", "simulatedTEE", "localMode", "local_mode"} {
		value, ok := findValue(payload, key)
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			if typed {
				return true
			}
		case string:
			if strings.EqualFold(strings.TrimSpace(typed), "true") || strings.EqualFold(strings.TrimSpace(typed), "simulated") {
				return true
			}
		}
	}
	return false
}

func sameHex(left, right string) bool {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(left)), "0x") == strings.TrimPrefix(strings.ToLower(strings.TrimSpace(right)), "0x")
}

func sameScalar(left, right string) bool {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if strings.EqualFold(left, right) {
		return true
	}
	leftValue, leftErr := parseScalar(left)
	rightValue, rightErr := parseScalar(right)
	return leftErr == nil && rightErr == nil && leftValue == rightValue
}

func parseScalar(value string) (uint64, error) {
	if strings.HasPrefix(strings.ToLower(value), "0x") {
		return strconv.ParseUint(value[2:], 16, 64)
	}
	return strconv.ParseUint(value, 10, 64)
}

func realAttestationFailure(fingerprint string, ttl time.Duration, err error) attestationSummary {
	summary := attestationSummary{Error: err.Error()}
	cacheAttestation(fingerprint, ttl, summary)
	return summary
}

func cacheAttestation(fingerprint string, ttl time.Duration, summary attestationSummary) {
	realAttestation.mu.Lock()
	defer realAttestation.mu.Unlock()
	realAttestation.fingerprint = fingerprint
	realAttestation.expiresAt = time.Now().Add(ttl)
	realAttestation.summary = summary
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func containsFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}

func uniqueFold(values []string) int {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		seen[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
	}
	return len(seen)
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

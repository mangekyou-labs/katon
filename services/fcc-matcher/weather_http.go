package matcher

// WeatherHTTP exposes the small FCC Weather extension wire surface. The
// private key is loaded only by the TEE process; callers submit ciphertext and
// receive an ActionResult, while /decrypt is restricted to the local node
// boundary for the extension's own use.

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type WeatherExtension struct {
	teeID       string
	extensionID string
	version     string
	privateKey  []byte
	now         func() uint64
	inner       *ScaffoldExtension
	mu          sync.RWMutex
	results     map[string]ScaffoldActionResult
}

func NewWeatherExtension(teeID, extensionID, version string, privateKey []byte, now func() uint64) (*WeatherExtension, error) {
	if teeID == "" || extensionID == "" || version == "" || len(privateKey) != 32 {
		return nil, errors.New("FCC_WEATHER_CONFIG")
	}
	if now == nil {
		now = func() uint64 { return uint64(time.Now().Unix()) }
	}
	extension := &WeatherExtension{teeID: teeID, extensionID: extensionID, version: version, privateKey: append([]byte(nil), privateKey...), now: now, results: make(map[string]ScaffoldActionResult)}
	extension.inner = NewScaffoldExtension(ScaffoldConfig{TEEID: teeID, Now: now(), Decrypt: extension.decryptViaNode})
	return extension, nil
}

// NewWeatherExtensionFromEnv creates a node for local rehearsal. Production
// deployments should inject the key through the TEE node secret mechanism.
func NewWeatherExtensionFromEnv() *WeatherExtension {
	teeID := os.Getenv("FCC_TEE_ID")
	extensionID := os.Getenv("FCC_EXTENSION_ID")
	version := os.Getenv("FCC_EXTENSION_VERSION")
	if version == "" {
		version = "1.0.0"
	}
	keyHex := strings.TrimPrefix(os.Getenv("FCC_TEE_PRIVATE_KEY"), "0x")
	key, _ := hex.DecodeString(keyHex)
	if len(key) != 32 {
		return &WeatherExtension{teeID: teeID, extensionID: extensionID, version: version}
	}
	ext, err := NewWeatherExtension(teeID, extensionID, version, key, nil)
	if err != nil {
		return &WeatherExtension{teeID: teeID, extensionID: extensionID, version: version}
	}
	return ext
}

func (e *WeatherExtension) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/info":
		e.info(response, request)
	case "/state":
		e.state(response, request)
	case "/action":
		e.action(response, request)
	case "/instruction":
		e.instruction(response, request)
	case "/decrypt":
		e.decrypt(response, request)
	default:
		if strings.HasPrefix(request.URL.Path, "/action/status/") {
			e.status(response, request)
			return
		}
		writeWeatherError(response, http.StatusNotFound, "NOT_FOUND")
	}
}

func (e *WeatherExtension) info(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeWeatherError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	publicKey, err := PublicKeyFromPrivate(e.privateKey)
	if err != nil {
		writeWeatherError(response, http.StatusServiceUnavailable, "FCC_NODE_NOT_READY")
		return
	}
	writeWeatherJSON(response, http.StatusOK, map[string]any{
		"extensionId":         e.extensionID,
		"version":             e.version,
		"teeId":               e.teeID,
		"encryptionPublicKey": "0x" + hex.EncodeToString(publicKey),
		"encryptionKeyId":     keccakHex(publicKey),
	})
}

func (e *WeatherExtension) state(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeWeatherError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	// This milestone is stateless: no auction plaintext is persisted in the
	// extension or its proxy state. Keep the response deliberately empty.
	writeWeatherJSON(response, http.StatusOK, map[string]any{"state": map[string]any{}})
}

func (e *WeatherExtension) action(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeWeatherError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if e.inner == nil {
		writeWeatherError(response, http.StatusServiceUnavailable, "FCC_NODE_NOT_READY")
		return
	}
	var action ScaffoldAction
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxFccEnvelopeBytes)).Decode(&action); err != nil {
		writeWeatherError(response, http.StatusBadRequest, "ACTION_JSON")
		return
	}
	e.writeActionResult(response, action)
}

// instruction is the provider-facing proxy boundary used by the official FCC
// runtime. The proxy receives the cosigned instruction here and hands it to
// the same extension action handler used by the local Weather conformance
// surface. No instruction discovery or indexer polling happens in this path.
func (e *WeatherExtension) instruction(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeWeatherError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if e.inner == nil {
		writeWeatherError(response, http.StatusServiceUnavailable, "FCC_NODE_NOT_READY")
		return
	}
	var action ScaffoldAction
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxFccEnvelopeBytes)).Decode(&action); err != nil {
		writeWeatherError(response, http.StatusBadRequest, "ACTION_JSON")
		return
	}
	e.writeActionResult(response, action)
}

func (e *WeatherExtension) writeActionResult(response http.ResponseWriter, action ScaffoldAction) {
	result, status, err := e.inner.ProcessAction(action)
	if err != nil && status >= 400 {
		writeWeatherJSON(response, status, result)
		return
	}
	e.mu.Lock()
	e.results[action.Data.ID] = result
	e.mu.Unlock()
	writeWeatherJSON(response, status, result)
}

func (e *WeatherExtension) status(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeWeatherError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/action/status/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeWeatherError(response, http.StatusBadRequest, "ACTION_STATUS_PATH")
		return
	}
	e.mu.RLock()
	result, ok := e.results[parts[1]]
	e.mu.RUnlock()
	if !ok {
		writeWeatherError(response, http.StatusNotFound, "ACTION_NOT_FOUND")
		return
	}
	writeWeatherJSON(response, http.StatusOK, result)
}

// decryptViaNode is the only decryption callback visible to the action
// handler. In a deployed Weather stack this callback is the local TEE-node
// client; the rehearsal keeps the same boundary in-process while /decrypt is
// exposed as the node endpoint for wire tests.
func (e *WeatherExtension) decryptViaNode(envelope FccRecipientEnvelopeV1, teeID string, now uint64) ([]byte, error) {
	if len(e.privateKey) != 32 {
		return nil, errors.New("FCC_NODE_NOT_READY")
	}
	return DecryptFccRecipient(envelope, teeID, e.privateKey, now)
}

type weatherDecryptRequest struct {
	Envelope string `json:"envelope"`
	TEEID    string `json:"teeId"`
	Now      uint64 `json:"now"`
}

func (e *WeatherExtension) decrypt(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeWeatherError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if token := os.Getenv("FCC_NODE_DECRYPT_TOKEN"); token != "" && request.Header.Get("X-FCC-Node-Token") != token {
		writeWeatherError(response, http.StatusUnauthorized, "FCC_NODE_AUTH")
		return
	}
	if len(e.privateKey) != 32 {
		writeWeatherError(response, http.StatusServiceUnavailable, "FCC_NODE_NOT_READY")
		return
	}
	var input weatherDecryptRequest
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxFccEnvelopeBytes)).Decode(&input); err != nil || input.Envelope == "" {
		writeWeatherError(response, http.StatusBadRequest, "DECRYPT_REQUEST")
		return
	}
	envelopeBytes, err := decodeHexBytes(input.Envelope)
	if err != nil {
		writeWeatherError(response, http.StatusBadRequest, "DECRYPT_REQUEST")
		return
	}
	envelope, err := ParseFccEnvelope(envelopeBytes)
	if err != nil {
		writeWeatherError(response, http.StatusBadRequest, err.Error())
		return
	}
	now := input.Now
	if now == 0 {
		now = e.now()
	}
	plaintext, err := DecryptFccRecipient(envelope, input.TEEID, e.privateKey, now)
	if err != nil {
		writeWeatherError(response, http.StatusBadRequest, err.Error())
		return
	}
	writeWeatherJSON(response, http.StatusOK, map[string]any{"plaintext": "0x" + hex.EncodeToString(plaintext), "commitment": envelope.PlaintextCommitment})
}

func writeWeatherError(response http.ResponseWriter, status int, message string) {
	writeWeatherJSON(response, status, map[string]string{"error": message})
}

func writeWeatherJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("content-type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

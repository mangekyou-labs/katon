package matcher

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWeatherHTTPInfoAndDecryptStayAtNodeBoundary(t *testing.T) {
	key := bytesFilled(19)
	extension, err := NewWeatherExtension("tee-a", "65537", "1.0.0", key, func() uint64 { return 1_700_000_000 })
	if err != nil {
		t.Fatal(err)
	}
	info := httptest.NewRecorder()
	extension.ServeHTTP(info, httptest.NewRequest(http.MethodGet, "/info", nil))
	if info.Code != http.StatusOK || !bytes.Contains(info.Body.Bytes(), []byte("encryptionPublicKey")) {
		t.Fatalf("info status=%d body=%s", info.Code, info.Body.Bytes())
	}
	metadata := FccEnvelopeMetadata{ChainID: 114, ExtensionID: "0x" + stringFilled('1', 64), ActionID: "0x" + stringFilled('2', 64), OPType: OpRFQ, Command: CommandCreate, Expiry: 1_800_000_000}
	envelope, err := EncryptFccEnvelope([]byte(`{"commitment":"0xabc"}`), metadata, []FccEncryptionRecipient{
		{TEEID: "tee-a", KeyID: "key-a", PublicKey: mustPublicKey(t, key)},
		{TEEID: "tee-b", KeyID: "key-b", PublicKey: mustPublicKey(t, bytesFilled(20))},
		{TEEID: "tee-c", KeyID: "key-c", PublicKey: mustPublicKey(t, bytesFilled(21))},
	}, [][]byte{bytesFilledN(1, 12), bytesFilledN(2, 12), bytesFilledN(3, 12)})
	if err != nil {
		t.Fatal(err)
	}
	original, err := CanonicalFccEnvelope(envelope)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(weatherDecryptRequest{Envelope: "0x" + hex.EncodeToString(original), TEEID: "tee-a", Now: 1_700_000_000})
	decrypt := httptest.NewRecorder()
	extension.ServeHTTP(decrypt, httptest.NewRequest(http.MethodPost, "/decrypt", bytes.NewReader(body)))
	if decrypt.Code != http.StatusOK || !bytes.Contains(decrypt.Body.Bytes(), []byte("commitment")) {
		t.Fatalf("decrypt status=%d body=%s", decrypt.Code, decrypt.Body.Bytes())
	}
}

func TestWeatherHTTPInstructionAndStatusUseProxyBoundary(t *testing.T) {
	key := bytesFilled(31)
	fixed := ScaffoldDataFixed{
		InstructionID:   "0x" + stringFilled('3', 64),
		TEEID:           "tee-a",
		Timestamp:       1_700_000_000,
		OPType:          bytes32Identifier(OpRFQ),
		OPCommand:       bytes32Identifier(CommandCreate),
		OriginalMessage: "",
	}
	plaintext := []byte(`{"commitment":"0xabc"}`)
	metadata := FccEnvelopeMetadata{ChainID: 114, ExtensionID: "0x" + stringFilled('1', 64), ActionID: fixed.InstructionID, OPType: OpRFQ, Command: CommandCreate, Expiry: 1_800_000_000}
	envelope, err := EncryptFccEnvelope(plaintext, metadata, []FccEncryptionRecipient{
		{TEEID: "tee-a", KeyID: "key-a", PublicKey: mustPublicKey(t, key)},
		{TEEID: "tee-b", KeyID: "key-b", PublicKey: mustPublicKey(t, bytesFilled(32))},
		{TEEID: "tee-c", KeyID: "key-c", PublicKey: mustPublicKey(t, bytesFilled(33))},
	}, [][]byte{bytesFilledN(1, 12), bytesFilledN(2, 12), bytesFilledN(3, 12)})
	if err != nil {
		t.Fatal(err)
	}
	original, err := CanonicalFccEnvelope(envelope)
	if err != nil {
		t.Fatal(err)
	}
	fixed.OriginalMessage = "0x" + hex.EncodeToString(original)
	fixedBytes, err := json.Marshal(fixed)
	if err != nil {
		t.Fatal(err)
	}
	action := ScaffoldAction{Data: ScaffoldActionData{ID: fixed.InstructionID, Type: "TEE_ACTION", SubmissionTag: "TEE_ACTION_RESULT", Message: "0x" + hex.EncodeToString(fixedBytes)}}
	body, _ := json.Marshal(action)
	extension, err := NewWeatherExtension("tee-a", "65537", "1.0.0", key, func() uint64 { return 1_700_000_000 })
	if err != nil {
		t.Fatal(err)
	}
	instruction := httptest.NewRecorder()
	extension.ServeHTTP(instruction, httptest.NewRequest(http.MethodPost, "/instruction", bytes.NewReader(body)))
	if instruction.Code != http.StatusOK {
		t.Fatalf("instruction status=%d body=%s", instruction.Code, instruction.Body.Bytes())
	}
	status := httptest.NewRecorder()
	extension.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/action/status/1700000000/"+fixed.InstructionID, nil))
	if status.Code != http.StatusOK || !bytes.Contains(status.Body.Bytes(), []byte(fixed.InstructionID)) {
		t.Fatalf("status=%d body=%s", status.Code, status.Body.Bytes())
	}
}

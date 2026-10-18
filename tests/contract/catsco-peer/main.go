// Test-only HTTPS host for the real CatsCo handler. The store below is an
// explicit test double: this proves wire compatibility, not PostgreSQL or
// live Bot authority. All credentials and identity values are synthetic.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/openchat/openchat/server"
	"github.com/openchat/openchat/server/store"
)

type fixtureStore struct {
	store.Store
	issuer       string
	epoch        atomic.Int64
	mu           sync.Mutex
	receipt      *store.SkillHubPublicationCloudReceipt
	receiptCalls int
	cancelled    bool
}

// Discard the response without stripping the real connection's read-deadline
// support. The production handler deliberately fails closed without it.
type lostACKWriter struct {
	*httptest.ResponseRecorder
	underlying http.ResponseWriter
}

func (w *lostACKWriter) Unwrap() http.ResponseWriter { return w.underlying }

// Explicit receipt ledger double. The real handler still authenticates,
// strictly decodes and binds configured scope before invoking this method.
func (s *fixtureStore) RecordSkillHubPublicationCloudReceipt(ctx context.Context, r store.SkillHubPublicationCloudReceipt) (*store.SkillHubPublicationCloudReceiptResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.receiptCalls++
	n, err := strconv.ParseInt(os.Getenv("PEER_TEST_BYTES"), 10, 64)
	if err != nil || r.Validate() != nil || r.Query.Issuer != s.issuer || r.Query.Audience != "https://hub.example" ||
		r.Query.EntryID != "pubentry_"+strings.Repeat("3", 32) || r.Query.Epoch != 1 ||
		r.Query.RequestHash != os.Getenv("PEER_TEST_HASH") || r.Query.SourceSnapshotHash != os.Getenv("PEER_TEST_SOURCE_HASH") || r.Query.RequestBytes != n ||
		r.DelegationID != "pubgrant_"+strings.Repeat("6", 32) || r.IdempotencyKey != "pubcandidate_"+strings.Repeat("5", 32) {
		return nil, store.ErrSkillHubPublicationConflict
	}
	if s.receipt != nil && *s.receipt != r {
		return nil, store.ErrSkillHubPublicationConflict
	}
	if s.receipt == nil {
		copy := r
		s.receipt = &copy
	}
	return &store.SkillHubPublicationCloudReceiptResult{Receipt: r, LocalIntentCancelled: s.cancelled}, nil
}

func (s *fixtureStore) IntrospectSkillHubPublicationUploadGrant(ctx context.Context, token store.SkillHubPublicationUploadToken, q store.SkillHubPublicationUploadQuery) (*store.SkillHubPublicationUploadObservation, error) {
	n, err := strconv.ParseInt(os.Getenv("PEER_TEST_BYTES"), 10, 64)
	epoch := int(s.epoch.Load())
	secret := "2"
	if epoch > 1 {
		secret = "7"
	}
	if err != nil || q.Validate() != nil || token.Reveal() != "pubupload_"+strings.Repeat(secret, 64) ||
		q.EntryID != "pubentry_"+strings.Repeat("3", 32) || q.Epoch != epoch ||
		q.RequestHash != os.Getenv("PEER_TEST_HASH") || q.SourceSnapshotHash != os.Getenv("PEER_TEST_SOURCE_HASH") || q.RequestBytes != n {
		return nil, store.ErrSkillHubPublicationDenied
	}
	now := time.Now().UTC()
	in := store.SkillHubPublicationUploadInput{
		EntryID: q.EntryID, Issuer: s.issuer, Audience: "https://hub.example", Action: "candidate.upload",
		Revision: 1, RequestHash: q.RequestHash, SourceSnapshotHash: q.SourceSnapshotHash, RequestBytes: q.RequestBytes,
		Binding: store.SkillHubPublicationDeliveryBinding{ActorUID: 9223372036854775806, BotUID: 42,
			NodeID: "private-node", ConnectionID: "private-socket",
			Source: store.SkillHubPublicationSource{DeviceID: "private-device", BodyID: "private-body",
				InstallationID: "private-install", RouteGeneration: 1, WorkspaceGeneration: "workspace-1", LocalSkillID: "private-source"}},
	}
	return &store.SkillHubPublicationUploadObservation{ObservedAt: now, Grant: &store.SkillHubPublicationUploadGrant{
		ID: "pubgrant_" + strings.Repeat("6", 32), Input: in, Epoch: epoch,
		IdempotencyKey: "pubcandidate_" + strings.Repeat("5", 32), IssuedAt: now.Add(-time.Second), ExpiresAt: now.Add(119 * time.Second),
	}}, nil
}

func main() {
	var handler atomic.Pointer[server.SkillHubPublicationPeerHandler]
	var loseACK atomic.Bool
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/skillhub/publications/internal/cloud-receipts" && loseACK.Swap(false) {
			// Real handler/store accept the evidence; drop the response afterward.
			recorded := &lostACKWriter{httptest.NewRecorder(), w}
			handler.Load().Handle(recorded, r)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		handler.Load().Handle(w, r)
	}))
	defer tls.Close()
	os.Setenv("CATSCO_SKILLHUB_PUBLICATION_INTROSPECTION_ENABLED", "true")
	os.Setenv("CATSCO_SKILLHUB_PUBLICATION_CLOUD_RECEIPTS_ENABLED", "true")
	os.Setenv("CATSCO_SKILLHUB_PUBLICATION_ISSUER", tls.URL)
	os.Setenv("CATSCO_SKILLHUB_PUBLICATION_CLOUD_AUDIENCE", "https://hub.example")
	os.Setenv("CATSCO_SKILLHUB_PUBLICATION_CLOUD_PEER_SECRET", strings.Repeat("1", 64))
	os.Setenv("CATSCO_SKILLHUB_PUBLICATION_TRUSTED_PROXY_CIDRS", "")
	fixture := &fixtureStore{issuer: tls.URL}
	fixture.epoch.Store(1)
	handler.Store(server.NewSkillHubPublicationPeerHandlerFromEnv(fixture))
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tls.Certificate().Raw})
	json.NewEncoder(os.Stdout).Encode(map[string]string{"origin": tls.URL, "ca": string(cert)})
	// Test control is stdin only, never an HTTP route. Mirrors the ledger's
	// stable grant ID/key and incrementing epoch; this store remains a double.
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		switch scanner.Text() {
		case "rotate":
			fixture.epoch.Store(2)
			json.NewEncoder(os.Stdout).Encode(map[string]int{"epoch": 2})
		case "lose-ack":
			loseACK.Store(true)
			json.NewEncoder(os.Stdout).Encode(map[string]bool{"ready": true})
		case "cancel":
			fixture.mu.Lock()
			fixture.cancelled = true
			fixture.mu.Unlock()
			json.NewEncoder(os.Stdout).Encode(map[string]bool{"cancelled": true})
		case "receipt":
			fixture.mu.Lock()
			json.NewEncoder(os.Stdout).Encode(map[string]any{"calls": fixture.receiptCalls, "receipt": fixture.receipt})
			fixture.mu.Unlock()
		}
	}
}

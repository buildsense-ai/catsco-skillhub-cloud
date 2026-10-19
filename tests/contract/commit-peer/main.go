// Test-only dual-store fixture. Real CatsCo PostgreSQL, peer handler and TLS.
// Commands seed trusted human intent; they are NOT production admission APIs.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/openchat/openchat/server"
	"github.com/openchat/openchat/server/db/postgres"
	"github.com/openchat/openchat/server/store"
	"github.com/openchat/openchat/server/store/types"
)

type capture struct {
	http.ResponseWriter
	record *httptest.ResponseRecorder
}

func (w *capture) Header() http.Header         { return w.record.Header() }
func (w *capture) WriteHeader(s int)           { w.record.WriteHeader(s) }
func (w *capture) Write(b []byte) (int, error) { return w.record.Write(b) }
func (w *capture) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type wireReceipt struct {
	SchemaVersion int    `json:"schemaVersion"`
	EntryID       string `json:"entryRequestId"`
	Revision      int    `json:"candidateRevision"`
	Epoch         int    `json:"acceptanceEpoch"`
	RequestHash   string `json:"requestHash"`
	SourceHash    string `json:"sourceSnapshotHash"`
	Bytes         int64  `json:"requestBytes"`
	Grant         string `json:"delegationId"`
	Key           string `json:"idempotencyKey"`
	Task          string `json:"taskId"`
	Event         string `json:"eventId"`
}

func (r wireReceipt) input(issuer string) store.SkillHubPublicationCloudReceipt {
	return store.SkillHubPublicationCloudReceipt{Query: store.SkillHubPublicationUploadQuery{Issuer: issuer, Audience: "https://hub.example", Action: store.SkillHubPublicationUploadAction,
		EntryID: r.EntryID, Revision: r.Revision, Epoch: r.Epoch, RequestHash: r.RequestHash, SourceSnapshotHash: r.SourceHash, RequestBytes: r.Bytes},
		DelegationID: r.Grant, IdempotencyKey: r.Key, TaskID: r.Task, EventID: r.Event}
}

type command struct {
	Action      string                                `json:"action"`
	Receipt     wireReceipt                           `json:"receipt"`
	Target      store.SkillHubPublicationCommitTarget `json:"target"`
	RequestHash string                                `json:"requestHash"`
	SourceHash  string                                `json:"sourceHash"`
	Bytes       int64                                 `json:"bytes"`
	Actor       string                                `json:"actor"`
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	dsn := os.Getenv("CATS_PG_TEST_DSN")
	if dsn == "" {
		panic("test database required")
	}
	admin, err := sql.Open("pgx", dsn)
	must(err)
	defer admin.Close()
	schema := fmt.Sprintf("cats_commit_full_%d", time.Now().UnixNano())
	_, err = admin.Exec(`CREATE SCHEMA "` + schema + `"`)
	must(err)
	defer admin.Exec(`DROP SCHEMA "` + schema + `" CASCADE`)
	u, err := url.Parse(dsn)
	must(err)
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	scoped, err := sql.Open("pgx", u.String())
	must(err)
	defer scoped.Close()
	var a *postgres.Adapter
	open := func() { a = &postgres.Adapter{}; must(a.Open(u.String())) }
	open()
	must(a.CreateSchema())
	defer func() { a.Close() }()
	var handler atomic.Pointer[server.SkillHubPublicationPeerHandler]
	var lose atomic.Bool
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		record := httptest.NewRecorder()
		handler.Load().Handle(&capture{w, record}, r)
		if r.URL.Path == server.SkillHubPublicationCommitPermitPath && record.Code == 200 && lose.Swap(false) {
			c, _, err := http.NewResponseController(w).Hijack()
			must(err)
			c.Close()
			return
		}
		for k, v := range record.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(record.Code)
		w.Write(record.Body.Bytes())
	}))
	issuer := "https://" + ts.Listener.Addr().String()
	for _, name := range []string{"INTROSPECTION", "CLOUD_RECEIPTS", "COMMIT_PERMITS"} {
		must(os.Setenv("CATSCO_SKILLHUB_PUBLICATION_"+name+"_ENABLED", "true"))
	}
	must(os.Setenv("CATSCO_SKILLHUB_PUBLICATION_ISSUER", issuer))
	must(os.Setenv("CATSCO_SKILLHUB_PUBLICATION_CLOUD_AUDIENCE", "https://hub.example"))
	must(os.Setenv("CATSCO_SKILLHUB_PUBLICATION_CLOUD_PEER_SECRET", strings.Repeat("1", 64)))
	must(os.Setenv("CATSCO_SKILLHUB_PUBLICATION_TRUSTED_PROXY_CIDRS", ""))
	handler.Store(server.NewSkillHubPublicationPeerHandlerFromEnv(a))
	ts.StartTLS()
	defer ts.Close()
	out := json.NewEncoder(os.Stdout)
	must(out.Encode(map[string]any{"origin": issuer, "ca": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ts.Certificate().Raw}))}))
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), 65536)
	for scan.Scan() {
		var c command
		must(json.Unmarshal(scan.Bytes(), &c))
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		var result any = map[string]bool{"ok": true}
		switch c.Action {
		case "seed":
			suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
			actor, err := a.CreateUser(&types.User{Username: "human-" + suffix, AccountType: types.AccountHuman, PassHash: []byte("test")})
			must(err)
			bot, err := a.CreateUser(&types.User{Username: "bot-" + suffix, AccountType: types.AccountBot, PassHash: []byte("test")})
			must(err)
			must(a.SaveBotConfigWithOwner(bot, actor, "", ""))
			_, err = scoped.Exec("UPDATE bot_config SET body_id='test-body' WHERE user_id=$1", bot)
			must(err)
			generation, err := a.BumpBotConnectionGeneration(bot)
			must(err)
			source := store.SkillHubPublicationSource{DeviceID: "test-device", BodyID: "test-body", InstallationID: "test-install", RouteGeneration: int64(generation), WorkspaceGeneration: "test-rev", LocalSkillID: "test-skill"}
			entry, _, err := a.CreateSkillHubPublicationEntry(ctx, store.SkillHubPublicationEntryInput{ActorUID: actor, BotUID: bot, Entrypoint: "workspace", RequestID: "request-" + suffix, Source: source}, store.DefaultSkillHubPublicationEntryPolicy())
			must(err)
			binding := store.SkillHubPublicationDeliveryBinding{ActorUID: actor, BotUID: bot, Source: source, NodeID: "test-node", ConnectionID: "test-connection"}
			probe, err := a.ClaimSkillHubPublicationDelivery(ctx, entry.ID, binding)
			must(err)
			must(a.FinishSkillHubPublicationDelivery(ctx, *probe, ""))
			g, token, err := a.IssueSkillHubPublicationUploadGrant(ctx, store.SkillHubPublicationUploadInput{EntryID: entry.ID, Binding: binding, Issuer: issuer, Audience: "https://hub.example", Action: store.SkillHubPublicationUploadAction, Revision: 1, RequestHash: c.RequestHash, SourceSnapshotHash: c.SourceHash, RequestBytes: c.Bytes})
			must(err)
			result = map[string]any{"actor": strconv.FormatInt(actor, 10), "entryRequestId": entry.ID, "token": token.Reveal(), "idempotencyKey": g.IdempotencyKey, "authorityEpoch": g.Epoch}
		case "admit":
			actor, err := strconv.ParseInt(c.Actor, 10, 64)
			must(err)
			_, err = a.RecordSkillHubPublicationCommitIntent(ctx, actor, store.SkillHubPublicationCommitInput{Receipt: c.Receipt.input(issuer), Target: c.Target})
			must(err)
		case "cancel":
			actor, err := strconv.ParseInt(c.Actor, 10, 64)
			must(err)
			_, err = a.RequestSkillHubPublicationCancellation(ctx, actor, c.Receipt.EntryID)
			must(err)
		case "lose":
			lose.Store(true)
		case "reopen":
			a.Close()
			open()
			handler.Store(server.NewSkillHubPublicationPeerHandlerFromEnv(a))
		case "count":
			var count int
			must(scoped.QueryRow("SELECT count(*) FROM skillhub_publication_commit_permits").Scan(&count))
			result = map[string]int{"count": count}
		default:
			panic("unknown fixture command")
		}
		cancel()
		must(out.Encode(result))
	}
	must(scan.Err())
}

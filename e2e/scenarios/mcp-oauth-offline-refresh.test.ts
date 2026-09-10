// Ordinary browser onboarding acquires renewal credentials advertised by the
// issuer separately from the MCP resource's read/write scopes.
import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { deriveMcpNamespace } from "@executor-js/plugin-mcp";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([mcpHttpPlugin(), toolkitsPlugin()] as const);
const expectedScopes = ["offline_access", "read", "write"];
const login = "refresh-user";
const scopeList = (scope: string) => scope.split(/\s+/).filter(Boolean).sort();
const RegistrationBody = Schema.Struct({ scope: Schema.String });
const TokenResponse = Schema.Struct({
  refresh_token: Schema.String,
  expires_in: Schema.Literal(5),
});
const TokenRequest = Schema.Struct({ grant_type: Schema.String });
const ToolOutcome = Schema.Struct({ ok: Schema.Boolean, data: Schema.Unknown });

const callIdentity = (session: McpSession, path: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", {
      code: `
let tool = tools;
for (const segment of ${JSON.stringify(path)}.split(".")) tool = tool[segment];
const result = await tool({});
return { ok: result.ok, data: result.ok ? result.data : result.error };
`,
    });
    for (let guard = 0; result.text.includes("executionId:") && guard < 10; guard += 1) {
      result = yield* session.approvePaused(result.text);
    }
    expect(result.ok, "the toolkit execution completes").toBe(true);
    const outcome = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ToolOutcome))(
      result.text,
    );
    expect(
      outcome,
      `the upstream identity tool succeeds without reconnecting: ${JSON.stringify(outcome.data)}`,
    ).toMatchObject({
      ok: true,
    });
    expect(
      JSON.stringify(outcome.data),
      "the tool returns the authorized user's identity",
    ).toContain(login);
  });

scenario(
  "MCP OAuth · browser onboarding acquires offline access and toolkit calls renew expired access tokens",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const baseUrl = yield* createEmulatorInstance("mcp", "offline-refresh");
    const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
    yield* Effect.promise(() =>
      emulator.seed({
        users: [{ login, name: "Refresh User" }],
        scopes: ["read", "write"],
        resourceScopes: ["read", "write"],
        authorizationServerScopes: ["read", "write", "offline_access"],
        oauth: { refreshTokens: true, accessTokenTtlSeconds: 5 },
      }),
    );
    const endpoint = `${baseUrl}/mcp`;
    const displayName = `Offline Refresh ${randomBytes(4).toString("hex")}`;
    const slug = IntegrationSlug.make(deriveMcpNamespace({ name: displayName }));
    const toolkitName = `${displayName} Toolkit`;

    yield* Effect.gen(function* () {
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Add the OAuth-protected MCP integration", async () => {
          await visit(page, `/integrations/add/mcp?url=${encodeURIComponent(endpoint)}`);
          await page.getByText("OAuth · Detected").waitFor({ timeout: 60_000 });
          await page.getByPlaceholder("e.g. Linear").fill(displayName);
          await page.getByRole("button", { name: "Add integration" }).click();
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          expect(new URL(page.url()).pathname.split("/").at(-1)).toBe(String(slug));
        });
        await step("Connect with automatic OAuth and authorize the seeded user", async () => {
          await page.getByRole("button", { name: "Add connection" }).first().click();
          await page.getByRole("heading", { name: /Add connection/ }).waitFor();
          const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
          await page.getByRole("button", { name: "Connect", exact: true }).click();
          const popup = await popupPromise;
          await popup
            .getByText("Authorize MCP client", { exact: true })
            .waitFor({ timeout: 30_000 });
          const authorization = new URL(popup.url());
          expect(authorization.href.startsWith(`${baseUrl}/authorize?`)).toBe(true);
          expect(
            scopeList(authorization.searchParams.get("scope") ?? ""),
            "normal onboarding includes issuer-advertised offline_access",
          ).toEqual(expectedScopes);
          expect(authorization.searchParams.get("resource")).toBe(endpoint);
          const consentResponse = popup.waitForResponse(
            (response) =>
              new URL(response.url()).pathname.endsWith("/authorize/approve") &&
              response.request().method() === "POST",
          );
          await popup.getByRole("button", { name: new RegExp(login) }).click();
          expect((await consentResponse).status(), "the seeded user grants authorization").toBe(
            302,
          );
          await page.getByRole("heading", { name: /Add connection/ }).waitFor({ state: "hidden" });
        });
        await Effect.runPromise(
          Effect.gen(function* () {
            const onboarding = yield* Effect.promise(() => emulator.ledger.list());
            const registration = onboarding.find(
              (entry) => entry.method === "POST" && entry.path === "/register",
            );
            expect(registration?.response.status, "dynamic registration succeeded").toBe(201);
            const registered = yield* Schema.decodeUnknownEffect(RegistrationBody)(
              registration?.request.body,
            );
            expect(
              scopeList(registered.scope),
              "DCR registers exactly the final authorization scopes",
            ).toEqual(expectedScopes);
            const initialGrant = onboarding.find(
              (entry) => entry.method === "POST" && entry.path === "/token",
            );
            expect(initialGrant?.response.status, "the authorization code was redeemed").toBe(200);
            const initialTokens = yield* Schema.decodeUnknownEffect(TokenResponse)(
              initialGrant?.response.body,
            );
            expect(
              initialTokens.refresh_token,
              "a refresh token was issued, with its value redacted",
            ).toBe("[redacted]");

            const connections = yield* client.connections.list({ query: { integration: slug } });
            expect(connections, "onboarding created one connection").toHaveLength(1);
            const connection = connections[0];
            if (!connection) return yield* Effect.die("OAuth onboarding created no connection");
            expect(
              scopeList(connection.oauthScope ?? ""),
              "saved granted scopes include offline access",
            ).toEqual(expectedScopes);
            const toolkit = yield* client.toolkits.create({
              payload: { owner: connection.owner, name: toolkitName },
            });
            yield* client.toolkits.createConnection({
              params: { toolkitId: toolkit.id },
              payload: { pattern: `${slug}.${connection.owner}.${connection.name}.*` },
            });
            const tools = yield* client.tools.list({ query: {} });
            const tool = tools.find(
              (candidate) => candidate.integration === slug && candidate.name === "get_me",
            );
            expect(tool, "the connected MCP identity tool is available").toBeDefined();
            if (!tool) return yield* Effect.die("Connected MCP identity tool is missing");
            const path = String(tool.address).split(".").slice(1).join(".");
            const session = mcp.session(identity, {
              url: new URL(`/mcp/toolkits/${toolkit.slug}`, target.baseUrl).toString(),
            });
            yield* Effect.promise(() =>
              step("Use the connected MCP identity tool through the toolkit", async () => {
                await Effect.runPromise(callIdentity(session, path));
                await page.getByText("Connections").first().waitFor();
              }),
            );
            const baseline = yield* Effect.promise(() => emulator.ledger.list());
            const baselineRefreshes = baseline.filter(
              (entry) => entry.operationId === "mcp.oauth.refreshToken",
            );
            // The five-second lifetime triggers proactive renewal during the
            // first use. The emulator consumes each refresh grant on success.
            expect(
              baselineRefreshes.length,
              "the first toolkit use already consumed and rotated a refresh credential",
            ).toBeGreaterThan(0);
            for (const refresh of baselineRefreshes) {
              expect(refresh.response.status, "baseline refresh grants succeeded").toBe(200);
            }
            yield* Effect.promise(() => emulator.ledger.clear());
            // Let the last short-lived access grant expire. Executor must use
            // its stored rotated credential: the emulator rejects spent grants.
            yield* Effect.sleep("6 seconds");
            yield* Effect.promise(() =>
              step("Use the toolkit again after its access token expires", async () => {
                await Effect.runPromise(callIdentity(session, path));
                await page.getByRole("button", { name: "Add connection" }).first().waitFor();
              }),
            );
            const recovery = yield* Effect.promise(() => emulator.ledger.list());
            const refreshed = recovery.filter(
              (entry) => entry.operationId === "mcp.oauth.refreshToken",
            );
            expect(refreshed, "Executor redeemed exactly one real refresh grant").toHaveLength(1);
            const refresh = refreshed[0];
            const refreshRequest = yield* Schema.decodeUnknownEffect(TokenRequest)(
              refresh?.request.body,
            );
            expect(refreshRequest.grant_type).toBe("refresh_token");
            expect(
              refresh?.response.status,
              "renewal succeeds with the persisted rotated credential; spent grants are rejected",
            ).toBe(200);
            const renewedTokens = yield* Schema.decodeUnknownEffect(TokenResponse)(
              refresh?.response.body,
            );
            expect(
              renewedTokens.refresh_token,
              "renewal issues a refresh token whose value is redacted in the ledger",
            ).toBe("[redacted]");
            expect(
              recovery.filter(
                (entry) =>
                  entry.method === "POST" && entry.path === "/mcp" && entry.response.status === 200,
              ).length,
              "the MCP call succeeds after renewal",
            ).toBeGreaterThan(0);
            yield* Effect.promise(() =>
              step(
                "Inspect the emulator's redacted refresh grant and successful MCP call",
                async () => {
                  await page.goto(`${baseUrl}/_emulate/ledger`, { waitUntil: "domcontentloaded" });
                  await page.getByText(/mcp\.oauth\.refreshToken/).waitFor();
                  expect(await page.locator("body").innerText()).toContain(
                    '"grant_type":"refresh_token"',
                  );
                },
              ),
            );
            const oauthClient = connection.oauthClient;
            const oauthClientOwner = connection.oauthClientOwner;
            if (!oauthClient || !oauthClientOwner)
              return yield* Effect.die("DCR connection has no OAuth client");
            // Reuse the registered client to check both scope-selection paths.
            // Cancel each start so the connected toolkit remains authorized.
            for (const discoveryCase of [
              {
                name: "declared-scope-check",
                scopes: ["read"] as const,
                resourceScopes: ["read", "write"],
                expected: ["offline_access", "read"],
              },
              {
                name: "issuer-fallback-scope-check",
                scopes: undefined,
                resourceScopes: null,
                expected: expectedScopes,
              },
            ]) {
              yield* Effect.promise(() =>
                emulator.seed({
                  scopes: ["read", "write"],
                  resourceScopes: discoveryCase.resourceScopes,
                  authorizationServerScopes: ["read", "write", "offline_access"],
                  oauth: { refreshTokens: true, accessTokenTtlSeconds: 5 },
                }),
              );
              yield* client.mcp.configureAuth({
                params: { slug },
                payload: {
                  mode: "replace",
                  authenticationTemplate: [
                    { slug: connection.template, kind: "oauth2", scopes: discoveryCase.scopes },
                  ],
                },
              });
              yield* Effect.promise(() => emulator.ledger.clear());
              const pending = yield* client.oauth.start({
                payload: {
                  client: oauthClient,
                  clientOwner: oauthClientOwner,
                  owner: connection.owner,
                  name: ConnectionName.make(discoveryCase.name),
                  integration: slug,
                  template: connection.template,
                },
              });
              expect(pending.status).toBe("redirect");
              if (pending.status !== "redirect")
                return yield* Effect.die("MCP OAuth scope check did not redirect");
              yield* Effect.gen(function* () {
                expect(
                  scopeList(new URL(pending.authorizationUrl).searchParams.get("scope") ?? ""),
                  `${discoveryCase.name} retains issuer-advertised offline access`,
                ).toEqual(discoveryCase.expected);
                const discovery = yield* Effect.promise(() => emulator.ledger.list());
                for (const metadata of ["oauth-protected-resource", "oauth-authorization-server"]) {
                  const reads = discovery.filter(
                    (entry) =>
                      entry.method === "GET" && entry.path.includes(`/.well-known/${metadata}`),
                  );
                  expect(
                    reads.map((entry) => ({ path: entry.path, status: entry.response.status })),
                    `${discoveryCase.name} reads ${metadata} once per authorization start`,
                  ).toHaveLength(1);
                  expect(reads[0]?.response.status, "metadata discovery succeeds").toBe(200);
                }
              }).pipe(
                Effect.ensuring(
                  client.oauth.cancel({ payload: { state: pending.state } }).pipe(Effect.ignore),
                ),
              );
            }
          }),
        );
      });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const listed = yield* client.toolkits.list();
          yield* Effect.forEach(
            listed.toolkits.filter((toolkit) => toolkit.name === toolkitName),
            (toolkit) => client.toolkits.remove({ params: { toolkitId: toolkit.id } }),
            { discard: true },
          );
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore)),
    );
  }),
);

#!/usr/bin/env node
"use strict";

const https = require("https");
const { URL } = require("url");

const ENDPOINT =
  process.env.STEER_GRAPHQL_URL ||
  "https://s55qpiwei1.execute-api.us-east-1.amazonaws.com";

const DEFAULT_USER = "0x15F53EFCD406EC4a57b1fda89136Fc3b1abFf33E";
const DEFAULT_VAULT = "0x9f627706a6EFD7BC65707FFE601c68e64a802504";
const USER_ARG = process.argv[2] || DEFAULT_USER;
const VAULT_ARG = process.argv[3] || DEFAULT_VAULT;
const CHAIN_ID = Number(process.env.STEER_CHAIN_ID || 14);

function postJson(url, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          accept: "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {}
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            raw: data,
            json: parsed,
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function runProbe(name, query, variables = {}) {
  const started = Date.now();
  try {
    const res = await postJson(ENDPOINT, { query, variables });
    const ms = Date.now() - started;
    const hasJson = !!res.json;
    const gqlErrors = Array.isArray(res.json?.errors) ? res.json.errors : [];
    const okHttp = res.status >= 200 && res.status < 300;
    const reachable = okHttp;

    console.log(`\n[${name}]`);
    console.log(`HTTP: ${res.status} (${ms}ms)`);
    console.log(`Reachable: ${reachable ? "YES" : "NO"}`);
    console.log(`JSON: ${hasJson ? "YES" : "NO"}`);
    if (gqlErrors.length) {
      console.log(`GraphQL errors: ${gqlErrors.length}`);
      for (const e of gqlErrors.slice(0, 2)) {
        console.log(`- ${e?.message || "unknown error"}`);
      }
    } else {
      console.log("GraphQL errors: 0");
    }

    const preview = hasJson
      ? JSON.stringify(res.json, null, 2)
      : (res.raw || "").slice(0, 400);
    console.log("Response preview:");
    console.log(preview.slice(0, 1200));
    return res;
  } catch (err) {
    const ms = Date.now() - started;
    console.log(`\n[${name}]`);
    console.log(`HTTP: n/a (${ms}ms)`);
    console.log("Reachable: NO");
    console.log(`Error: ${err?.message || err}`);
    return null;
  }
}

function unwrapType(t) {
  const parts = [];
  let cur = t;
  while (cur) {
    if (cur.kind === "NON_NULL") {
      parts.push("!");
      cur = cur.ofType;
      continue;
    }
    if (cur.kind === "LIST") {
      parts.push("[]");
      cur = cur.ofType;
      continue;
    }
    parts.push(cur.name || cur.kind || "?");
    break;
  }
  return parts.reverse().join("");
}

function printQueryFieldArgs(res, fieldNames) {
  const fields = res?.json?.data?.__type?.fields;
  if (!Array.isArray(fields)) return;
  console.log("\n[query-field-args]");
  for (const name of fieldNames) {
    const f = fields.find((x) => x?.name === name);
    if (!f) {
      console.log(`- ${name}: <not found>`);
      continue;
    }
    const args = Array.isArray(f.args) ? f.args : [];
    const argText = args.length
      ? args.map((a) => `${a.name}:${unwrapType(a.type)}`).join(", ")
      : "<no args>";
    console.log(`- ${name}(${argText}) -> ${unwrapType(f.type)}`);
  }
}

async function main() {
  console.log("Steer GraphQL connectivity test");
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`User: ${USER_ARG}`);
  console.log(`Vault: ${VAULT_ARG}`);
  console.log(`Chain: ${CHAIN_ID} (int)`);

  await runProbe("typename", "query { __typename }");

  const typeNames = [
    "Query",
    "VaultConnection",
    "VaultEdge",
    "VaultFilter",
    "UserVaultBalances",
    "VaultBalance",
    "Vault",
    "Token",
    "Pool",
  ];
  let queryTypeRes = null;
  for (const typeName of typeNames) {
    const res = await runProbe(
      `introspection:${typeName}`,
      `
        query($typeName: String!) {
          __type(name: $typeName) {
            name
            kind
          fields {
              name
              args {
                name
                type {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                    }
                  }
                }
              }
              type {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
        }
      `,
      { typeName }
    );
    if (typeName === "Query") queryTypeRes = res;
  }

  if (queryTypeRes) {
    printQueryFieldArgs(queryTypeRes, ["vaults", "vault", "userBalances"]);
  }

  await runProbe(
    "userBalances-basic",
    `
      query($user: String!) {
        userBalances(user: $user) {
          vaultBalances {
            chainId
            balance
          }
        }
      }
    `,
    { user: USER_ARG.toLowerCase() }
  );

  await runProbe(
    "vault-basic",
    `
      query($id: ID!, $chainId: Int!) {
        vault(id: $id, chainId: $chainId) {
          id
          chainId
          vaultAddress
          token0 { address symbol decimals name }
          token1 { address symbol decimals name }
          pool {
            id
            chainId
            poolAddress
            feeTier
          }
          protocol
          beaconName
        }
      }
    `,
    { id: VAULT_ARG.toLowerCase(), chainId: CHAIN_ID }
  );

  await runProbe(
    "vaults-discovery-nodes",
    `
      query {
        vaults(first: 25) {
          nodes {
            id
            vaultAddress
            chainId
            protocol
            beaconName
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    {}
  );

  await runProbe(
    "vaults-discovery-edges",
    `
      query {
        vaults(first: 25) {
          edges {
            node {
              id
              vaultAddress
              chainId
              protocol
              beaconName
            }
          }
          pageInfo { hasNextPage endCursor }
          totalCount
        }
      }
    `,
    {}
  );

  await runProbe(
    "vaults-filter-by-address",
    `
      query($addr: String!) {
        vaults(
          first: 10
          filter: { vaultAddress: { eq: $addr } }
        ) {
          edges {
            node {
              id
              vaultAddress
              chainId
              protocol
              beaconName
            }
          }
          totalCount
        }
      }
    `,
    { addr: VAULT_ARG.toLowerCase() }
  );
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

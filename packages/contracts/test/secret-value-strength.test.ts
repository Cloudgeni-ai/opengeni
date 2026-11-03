/**
 * Known-value masking by strength (docs/secrets.md, Matching): a weak saved
 * value (a dictionary word, a word with digits, a host) is replaced only in a
 * credential position, so file names, imports, identifiers, hosts and URL
 * paths that merely contain the word stay readable. Distinctive values
 * (tokens, random passwords) are replaced everywhere, in every form, as
 * before. Every value here is fake and assembled at runtime.
 */
import { describe, expect, test } from "bun:test";
import {
  compileSecretValueMasks,
  maskSecretShapesInText,
  maskSecretValuesInText,
  SecretValueMemory,
  secretValueStrength,
  type SecretValueMatchEvent,
} from "../src";

const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;
const LABEL = ref("Fake Vault/fake-db/password");
// A dictionary word, as a weak saved password or username would be.
const WORD = ["harbor", "master"].join("");
const DISTINCTIVE = ["Zq8", "vR2", "xW9", "pL4", "mT7", "kB1", "nY6"].join("");
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const scheme = (name: string) => `${name}://`;

function memoryWith(value: string, options: { weakValues?: "anywhere" } = {}) {
  const memory = new SecretValueMemory(options);
  memory.remember(value, LABEL);
  return memory;
}

describe("value strength", () => {
  test("words, words with digits, short values, hosts and emails are weak", () => {
    for (const value of [
      WORD,
      `${WORD}2024`,
      `${WORD[0]!.toUpperCase()}${WORD.slice(1)}1!`,
      WORD.toUpperCase(),
      "sunshine",
      `${WORD}.example.com`,
      `${WORD}@example.com`,
      `/srv/${WORD}/data`,
      `${WORD}User`,
      `deploy-${WORD}-01`,
      `${WORD[0]!.toUpperCase()}${WORD.slice(1)} Smith`,
      `db.${WORD}.example.com:5432`,
      `${scheme("https")}github.com/${WORD}/${WORD}-client`,
    ]) {
      expect([value, secretValueStrength(value)]).toEqual([value, "weak"]);
    }
  });

  test("tokens, random passwords and digit-only values are distinctive", () => {
    for (const value of [
      DISTINCTIVE,
      "Tr0ub4dor&3",
      `ghp_${DISTINCTIVE}${DISTINCTIVE}`,
      "4111111111111111",
      // A known token format, even a repetitive test value; a repetitive string.
      `ghp_${"Ab1Cd2Ef3".repeat(4)}`,
      "aaaaaaaaaaaaaaaaaaaa",
      `https://hooks.example.com/services/${DISTINCTIVE}`,
      // Random passwords that are short, repeat a character or have two kinds of characters.
      "aB3dE5aH7jK3",
      "k3j9x2m7q1",
      "a3f9c2e81b7d",
      // Random parts joined like a host, an email or a path.
      "bR7.kQ2.mX9.Lp",
      "kT9mQ.vX2pL.rZ8nW.hJ",
      "Xk9#mQ2$vL@Lp4.Rt",
      "./Xk9#mQ2$vLp4Rt8",
      // A passphrase of three or more words, and a run of letters that is not a word.
      "correct horse battery staple",
      "wiry-unwound-cable",
      "qkzvmxbtwe",
      "CruPjtBwrw",
      "FXIOFWLOJA",
      // A saved URL with a password in it.
      `${scheme("postgres")}app:${WORD}@db.example.com/app`,
    ]) {
      expect([value, secretValueStrength(value)]).toEqual([value, "distinctive"]);
    }
  });

  test("random hex, base64 and symbol passwords of 12 or more characters are distinctive", () => {
    // A fixed linear congruential generator keeps the samples reproducible.
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const alphabets = [
      "0123456789abcdef",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*",
    ];
    const weak: string[] = [];
    for (const alphabet of alphabets) {
      for (const length of [16, 24, 32, 40, 64, 128]) {
        for (let sample = 0; sample < 200; sample += 1) {
          let value = "";
          for (let index = 0; index < length; index += 1) {
            value += alphabet[Math.floor(next() * alphabet.length)];
          }
          if (secretValueStrength(value) === "weak") weak.push(value);
        }
      }
    }
    expect(weak).toEqual([]);
  });

  test("random letters rarely read as words", () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const lower = "abcdefghijklmnopqrstuvwxyz";
    for (const alphabet of [lower, `${lower}${lower.toUpperCase()}`, `${lower}0123456789`]) {
      for (const length of [10, 16, 24]) {
        let weak = 0;
        for (let sample = 0; sample < 1_000; sample += 1) {
          let value = "";
          for (let index = 0; index < length; index += 1) {
            value += alphabet[Math.floor(next() * alphabet.length)];
          }
          if (secretValueStrength(value) === "weak") weak += 1;
        }
        expect([alphabet.length, length, weak <= 30]).toEqual([alphabet.length, length, true]);
      }
    }
  });
});

test("random single-case letters and random host or URL parts are almost never weak", () => {
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const letters = (length: number) => {
    let value = "";
    for (let index = 0; index < length; index += 1)
      value += "abcdefghijklmnopqrstuvwxyz"[Math.floor(next() * 26)];
    return value;
  };
  // About 0.05% are weak at these lengths; 0.2% allows for the sample.
  for (const length of [10, 11, 12]) {
    let weak = 0;
    for (let sample = 0; sample < 5_000; sample += 1) {
      const value = letters(length);
      if (secretValueStrength(value) === "weak") weak += 1;
      if (secretValueStrength(value.toUpperCase()) === "weak") weak += 1;
    }
    expect([length, weak <= 20]).toEqual([length, true]);
  }
  for (const make of [
    (part: string) => `${scheme("https")}hooks.example.com/services/${part}`,
    (part: string) => `${part}.example.com`,
    (part: string) => `/srv/${part}/data`,
  ]) {
    let weak = 0;
    for (let sample = 0; sample < 5_000; sample += 1) {
      if (secretValueStrength(make(letters(12))) === "weak") weak += 1;
    }
    expect([make("x"), weak <= 10]).toEqual([make("x"), true]);
  }
  expect(secretValueStrength("rdabaootck")).toBe("distinctive");
  expect(secretValueStrength("kgkelsuschi")).toBe("distinctive");
  // Random letters with a space, and letters outside A to Z, are judged too.
  for (const value of [
    ["qkzvm", "xbtwp"].join(" "),
    `qkzvm${"\u00e9"}xbtwplj`,
    "\u041f\u0440\u0438\u0432\u0435\u0442\u043c\u0438\u0440",
  ]) {
    expect([value, secretValueStrength(value)]).toEqual([value, "distinctive"]);
  }
  expect(secretValueStrength("correct horse")).toBe("weak");
});

describe("a weak saved value", () => {
  test("does not alter paths, imports, identifiers, hosts or URL paths", () => {
    const memory = memoryWith(WORD);
    const unchanged = [
      `src/${WORD}/config.ts`,
      `packages/${WORD}-client/src/index.ts`,
      `import { ${WORD}Client } from "./${WORD}-client";`,
      `const ${WORD}_timeout = 30;`,
      `class ${WORD[0]!.toUpperCase()}${WORD.slice(1)}Service {}`,
      `ssh deploy@${WORD}.example.com`,
      `https://example.com/${WORD}/releases?tag=${WORD}-v2`,
      `C:\\Users\\${WORD}\\AppData`,
      `git log --author=${WORD}`,
      `{"path":"docs/${WORD}.md","name":"${WORD}-notes"}`,
      `The ${WORD} role owns the pipeline.`,
      // A credential word inside another word, or a key that is not one.
      `the monkey ate ${WORD} today`,
      `- name: DB_HOST\n  value: ${WORD}.example.com\n`,
      `- name: DB_HOST\n  value: ${WORD}\n`,
      // Options that do not take a password.
      `mkdir -p ${WORD}`,
      `cp -a ${WORD} /backup`,
      `ls -a ${WORD}`,
      `grep -a ${WORD} log.txt`,
      `git add -p ${WORD}`,
      `docker compose -p ${WORD} up -d`,
      `docker run --user www:${WORD} img`,
      // A credential word after the value, with no pipe.
      `${WORD} token refresh failed`,
      `cd ${WORD} && npm run token:refresh`,
      `${WORD}: api key rotated`,
      // Lines that only mention a key, a token or auth.
      `id SERIAL PRIMARY KEY, ${WORD} TEXT`,
      `FOREIGN KEY (x) REFERENCES ${WORD}(id)`,
      `fix token refresh in ${WORD}`,
      `the auth service ${WORD} is down`,
      `PWA build of ${WORD}`,
      `# rotate the api key\nproject: ${WORD}`,
      `password_policy:\n  name: ${WORD}`,
      // A pipe that does not feed a password reader.
      `| ${WORD} | Session token rotation |`,
      `const host = ${WORD} || getToken();`,
      `type Kind = "${WORD}" | "token";`,
      `UPDATE t SET col = ${WORD} || '{"sessionId":1}';`,
      `cat ${WORD} | wc -l  # count keys`,
      `echo ${WORD} | wc -l`,
      // Words that name other things.
      `--session ${WORD}`,
      `SESSION=${WORD} ./run.sh`,
      `const session = ${WORD}[next++]!;`,
      `return cond ? "private" : "${WORD}";`,
      `aws s3api get-object --key ${WORD} out`,
      `"@scope/vaults-onepassword": "${WORD}:*"`,
      `this bypass ${WORD} works`,
      `credential: {\n  rpId: "${WORD}",`,
      // Options that take a password only for some programs.
      `docker run -p ${WORD} img`,
      `ls -w ${WORD} x`,
      `grep -P ${WORD} log.txt`,
      // Arguments of the next command, prose after "password", lookup keys.
      `echo ${WORD} | grep -i token`,
      `echo ${WORD} | tee password-notes.txt`,
      `the password ${WORD} database is up`,
      `const STORAGE_KEY = "${WORD}";`,
      `cacheKey: ${WORD},`,
      `sortKey = ${WORD};`,
      // The weak value's base64 at the start of a longer base64 run.
      `config: ${base64(`${WORD}-dashboard settings v2`)}`,
    ];
    for (const text of unchanged) expect(memory.maskText(text)).toBe(text);
  });

  test("is still masked in credential positions", () => {
    const memory = memoryWith(WORD);
    const cases: Array<[string, string]> = [
      [`password=${WORD}`, `password=${LABEL}`],
      [`PGPASSWORD: ${WORD}`, `PGPASSWORD: ${LABEL}`],
      [`export DB_PASS="${WORD}"`, `export DB_PASS="${LABEL}"`],
      [JSON.stringify({ password: WORD }), JSON.stringify({ password: LABEL })],
      [`${WORD}\n`, `${LABEL}\n`],
      [`login ok\n${WORD}\nnext`, `login ok\n${LABEL}\nnext`],
      [
        `${scheme("mysql")}app:${WORD}@db.internal:3306/app`,
        `${scheme("mysql")}app:${LABEL}@db.internal:3306/app`,
      ],
      // Connection strings, lists and query strings.
      [`Server=db;Password=${WORD};Database=app`, `Server=db;Password=${LABEL};Database=app`],
      [`Driver={ODBC};PWD=${WORD};UID=sa`, `Driver={ODBC};PWD=${LABEL};UID=sa`],
      [`password=${WORD}&user=app`, `password=${LABEL}&user=app`],
      // More credential words.
      [`ADMIN_PW=${WORD}`, `ADMIN_PW=${LABEL}`],
      [JSON.stringify({ pw: WORD }), JSON.stringify({ pw: LABEL })],
      [JSON.stringify({ passcode: WORD }), JSON.stringify({ passcode: LABEL })],
      [`passwords: ${WORD}`, `passwords: ${LABEL}`],
      // Password options.
      [`mysql -u app -p${WORD} app`, `mysql -u app -p${LABEL} app`],
      [`sshpass -p ${WORD} ssh app@host`, `sshpass -p ${LABEL} ssh app@host`],
      [`redis-cli -a ${WORD} ping`, `redis-cli -a ${LABEL} ping`],
      [`curl -u admin:${WORD} https://x.test`, `curl -u admin:${LABEL} https://x.test`],
      [`curl --user admin:${WORD} https://x.test`, `curl --user admin:${LABEL} https://x.test`],
      // Piped into a command that reads a password.
      [
        `echo '${WORD}' | docker login --password-stdin`,
        `echo '${LABEL}' | docker login --password-stdin`,
      ],
      // The key on the line before.
      [
        `- name: DB_PASSWORD\n  value: ${WORD}\n- name: DB_HOST`,
        `- name: DB_PASSWORD\n  value: ${LABEL}\n- name: DB_HOST`,
      ],
      [`credentials:\n  admin: ${WORD}\nother: 1`, `credentials:\n  admin: ${LABEL}\nother: 1`],
      [
        `"env": [\n  {\n    "name": "DB_PASSWORD",\n    "value": "${WORD}"\n  }`,
        `"env": [\n  {\n    "name": "DB_PASSWORD",\n    "value": "${LABEL}"\n  }`,
      ],
      // Compound names, directives, statements, cookies and htpasswd.
      [`requirepass ${WORD}`, `requirepass ${LABEL}`],
      [`masterauth ${WORD}`, `masterauth ${LABEL}`],
      [`$dbpass = '${WORD}';`, `$dbpass = '${LABEL}';`],
      [`apikey=${WORD}`, `apikey=${LABEL}`],
      [`clientsecret=${WORD}`, `clientsecret=${LABEL}`],
      [`accesstoken: ${WORD}`, `accesstoken: ${LABEL}`],
      [`echo 'app:${WORD}' | chpasswd`, `echo 'app:${LABEL}' | chpasswd`],
      [`login app password ${WORD}`, `login app password ${LABEL}`],
      [`the password is ${WORD}.`, `the password is ${LABEL}.`],
      [`deploy --password ${WORD} --yes`, `deploy --password ${LABEL} --yes`],
      [`Cookie: theme=dark; sid=${WORD}`, `Cookie: theme=dark; sid=${LABEL}`],
      [`htpasswd -b .htpasswd admin ${WORD}`, `htpasswd -b .htpasswd admin ${LABEL}`],
      // More programs, file formats and statements that hold a password.
      [`docker login -u bob -p ${WORD}`, `docker login -u bob -p ${LABEL}`],
      [`oc login -u bob -p ${WORD} https://x.test`, `oc login -u bob -p ${LABEL} https://x.test`],
      [`az login -u bob -p ${WORD}`, `az login -u bob -p ${LABEL}`],
      [`mongosh -u bob -p ${WORD}`, `mongosh -u bob -p ${LABEL}`],
      [`ldapsearch -x -D cn=a -w ${WORD} -b dc=x`, `ldapsearch -x -D cn=a -w ${LABEL} -b dc=x`],
      [`sqlcmd -S db -U sa -P ${WORD}`, `sqlcmd -S db -U sa -P ${LABEL}`],
      [`zip -P ${WORD} out.zip f`, `zip -P ${LABEL} out.zip f`],
      [`7z a -p${WORD} out.7z f`, `7z a -p${LABEL} out.7z f`],
      [`smbclient //h/s -U bob%${WORD}`, `smbclient //h/s -U bob%${LABEL}`],
      [`db.example.com:5432:app:bob:${WORD}\n`, `db.example.com:5432:app:bob:${LABEL}\n`],
      [`<password>${WORD}</password>`, `<password>${LABEL}</password>`],
      [`<add key="Password" value="${WORD}" />`, `<add key="Password" value="${LABEL}" />`],
      [`CREATE USER a IDENTIFIED BY '${WORD}';`, `CREATE USER a IDENTIFIED BY '${LABEL}';`],
      [`echo ${WORD} | sudo -S true`, `echo ${LABEL} | sudo -S true`],
      [`?password=${WORD}&x=1`, `?password=${LABEL}&x=1`],
      // A program after a quote, a parenthesis or a backtick.
      [`{"cmd":"mysql -u root -p${WORD} app"}`, `{"cmd":"mysql -u root -p${LABEL} app"}`],
      [`(mysql -p${WORD})`, `(mysql -p${LABEL})`],
      ["`sshpass -p " + WORD + " ssh x`", "`sshpass -p " + LABEL + " ssh x`"],
      [`const API_KEY = "${WORD}";`, `const API_KEY = "${LABEL}";`],
      [`LICENSE_KEY=${WORD}`, `LICENSE_KEY=${LABEL}`],
      [`machine h login u password ${WORD} port 1`, `machine h login u password ${LABEL} port 1`],
      [JSON.stringify({ db: base64(WORD) }), JSON.stringify({ db: LABEL })],
    ];
    for (const [text, masked] of cases) expect(memory.maskText(text)).toBe(masked);
    // Its whole base64 encoding, as in a Kubernetes Secret, is replaced anywhere.
    const secret = `kind: Secret\ndata:\n  db: ${base64(WORD)}\n`;
    expect(memory.maskText(secret)).toBe(`kind: Secret\ndata:\n  db: ${LABEL}\n`);
    // Inside a base64 run (Basic auth): the encoded value is replaced in the run.
    const basic = `Authorization: Basic ${base64(`app:${WORD}`)}`;
    expect(memory.maskText(basic)).toContain(LABEL);
    expect(memory.maskText(basic)).not.toBe(basic);
  });

  test("is masked anywhere when the caller asks (the history scrub and typed values)", () => {
    const memory = memoryWith(WORD, { weakValues: "anywhere" });
    expect(memory.maskText(`src/${WORD}/config.ts`)).toBe(`src/${LABEL}/config.ts`);
  });

  test("inside a URL or connection string is still caught by the shape detectors", () => {
    const url = `${scheme("mysql")}app:${WORD}@db.internal:3306/app`;
    expect(maskSecretShapesInText(url)).toBe(
      `${scheme("mysql")}app:[masked url password]@db.internal:3306/app`,
    );
    const connection = `Server=db;User Id=app;Password=${WORD};Database=app`;
    expect(maskSecretShapesInText(connection)).toBe(
      "Server=db;User Id=app;Password=[masked connection string password];Database=app",
    );
  });
});

describe("a distinctive saved value", () => {
  test("is masked everywhere it was before, in every form", () => {
    const memory = memoryWith(DISTINCTIVE);
    const cases: Array<[string, string]> = [
      [`src/${DISTINCTIVE}/config.ts`, `src/${LABEL}/config.ts`],
      [`const x${DISTINCTIVE}y = 1;`, `const x${LABEL}y = 1;`],
      [`https://example.com/${DISTINCTIVE}?a=1`, `https://example.com/${LABEL}?a=1`],
      [`b64 ${base64(DISTINCTIVE)}`, `b64 ${LABEL}`],
      [`q=${encodeURIComponent(`${DISTINCTIVE}/+`)}`, `q=${LABEL}%2F%2B`],
    ];
    for (const [text, masked] of cases) expect(memory.maskText(text)).toBe(masked);
    expect(memory.maskText(`blob ${base64(`user:${DISTINCTIVE}:tail`)}`)).not.toContain(
      base64(`user:${DISTINCTIVE}:tail`),
    );
  });

  test("a clipped start at the end of a text is still masked", () => {
    const long = `${DISTINCTIVE}${[...DISTINCTIVE].reverse().join("")}`;
    const memory = memoryWith(long);
    const clipped = long.slice(0, Math.ceil(long.length * 0.75));
    // Output clipped to a size: a long text whose end cuts the value off.
    const output = `${"log line\n".repeat(200)}${clipped}`;
    expect(memory.maskText(output)).not.toContain(clipped);
    expect(memory.maskText(output)).toEndWith(LABEL);
  });

  test("the compiled masks behave the same with either weak-value policy", () => {
    const entries = [{ value: DISTINCTIVE, label: LABEL }];
    const texts = [
      `src/${DISTINCTIVE}/x`,
      `id_${DISTINCTIVE}_2`,
      JSON.stringify({ a: `pre${DISTINCTIVE}post` }),
      `b64 ${base64(DISTINCTIVE)}`,
    ];
    const positions = compileSecretValueMasks(entries);
    const anywhere = compileSecretValueMasks(entries, { weakValues: "anywhere" });
    for (const text of texts) {
      expect(maskSecretValuesInText(text, positions)).toBe(maskSecretValuesInText(text, anywhere));
      expect(maskSecretValuesInText(text, positions)).not.toContain(DISTINCTIVE);
    }
  });
});

describe("match metrics", () => {
  test("reports masked and kept occurrences without the value or the text", () => {
    const events: SecretValueMatchEvent[] = [];
    const memory = new SecretValueMemory({ onMatch: (event) => events.push(event) });
    memory.remember(WORD, LABEL);
    memory.remember(DISTINCTIVE, ref("Fake Vault/fake-api/value"));
    memory.maskText(`src/${WORD}/x.ts password=${WORD} token ${DISTINCTIVE}`);
    expect(events.map(({ outcome, strength, position }) => [outcome, strength, position])).toEqual([
      ["kept", "weak", "path"],
      ["masked", "weak", "token"],
      ["masked", "distinctive", "token"],
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(WORD);
    expect(serialized).not.toContain(DISTINCTIVE);
    for (const event of events) expect(event.entropy).toMatch(/^(?:lt32|32_64|64_128|ge128)$/u);
  });

  test("counts occurrences once per text and labels", () => {
    const events: SecretValueMatchEvent[] = [];
    const memory = new SecretValueMemory({ onMatch: (event) => events.push(event) });
    memory.remember(WORD, LABEL);
    memory.maskText(`src/${WORD}/a.ts src/${WORD}/b.ts src/${WORD}/c.ts`);
    expect(events.map(({ outcome, position, count }) => [outcome, position, count])).toEqual([
      ["kept", "path", 3],
    ]);
  });
});

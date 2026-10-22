import { describe, expect, it } from "vitest";
import { redactDetail, redactSecrets, redactSplitSecrets, userinfoRanges } from "../../src/core/redact.js";
import { sanitizeDetail } from "../../src/core/translate.js";

// Synthetic secrets are assembled at runtime so no literal credential sits in the repository.
const j = (...parts: string[]): string => parts.join("");
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const BS = String.fromCharCode(92); // a single backslash, so JSON escapes can be spelled out
const scheme = j("https", "://");
const GH_BODY = "abcdefghijklmnop1234";

/** Full pipeline at the largest output length (input cap 65 536 units). */
const clean = (input: string): string => sanitizeDetail(input, 4096);
const gone = (input: string, ...secrets: string[]): void => {
  const out = clean(input);
  expect(out).toContain("[redacted]");
  for (const secret of secrets) expect(out).not.toContain(secret);
};

describe("URL userinfo: all-digit passwords followed by '/', '?' or '#'", () => {
  it("redacts a digit password that cannot be a port (6+ digits or above 65535)", () => {
    for (const delim of ["/", "?", "#"]) {
      gone(`clone ${scheme}svc:1234567${delim}x@example.com/r`, "1234567");
      gone(`clone ${scheme}svc:99999${delim}x@example.com/r`, "99999");
      gone(`clone ${scheme}svc:65536${delim}x@example.com/r`, "65536");
    }
  });

  it("redacts a long digit password with leading zeros (value fits a port, shape does not)", () => {
    gone(`clone ${scheme}svc:0000080/x@example.com/r`, "0000080");
    gone(`clone ${scheme}svc:000080/x@example.com/r`, "000080");
  });

  it("still reads 1-5 digits up to 65535 as a port", () => {
    for (const port of ["80", "8080", "65535"]) {
      for (const delim of ["/", "?", "#"]) {
        const text = `${scheme}example.com:${port}${delim}p/a@b`;
        expect(clean(text)).toBe(text);
      }
    }
  });
});

describe("URL userinfo: the host after the '@'", () => {
  it("accepts a host that starts with a non-ASCII letter, a percent escape, or '-', '_', '.' into a letter", () => {
    for (const host of [`${cp(0xfc)}nicode.example`, `${cp(0x4e2d)}${cp(0x6587)}.example`, "%41host.example", "-host.example", "_host.example", ".host.example", "[::1]"]) {
      gone(`${scheme}svc:Zq7pwX@${host}/r`, "Zq7pwX");
    }
  });

  it("still requires a host: a bare '@' or one before punctuation only is not userinfo", () => {
    for (const text of [`${scheme}svc:pw@`, `${scheme}svc:pw@.`, `${scheme}svc:pw@-`, `${scheme}svc:pw@_`, `${scheme}svc:pw@%`, `${scheme}svc:pw@%zz`, `${scheme}svc:pw@/x`]) {
      expect(clean(text)).toBe(text);
    }
  });
});

describe("URL userinfo: long passwords (no window)", () => {
  it("redacts a password longer than 2048 units, with and without an inner '@'", () => {
    for (const length of [2047, 2048, 2049, 5000, 20_000]) {
      const pw = "Ab1".repeat(Math.ceil(length / 3)).slice(0, length);
      const out = clean(`x ${scheme}svc:${pw}@example.com/r y`);
      expect(out).toBe(`x ${scheme}[redacted]example.com/r y`);
      const withAt = `${pw.slice(0, 100)}@${pw.slice(100)}`;
      expect(clean(`x ${scheme}svc:${withAt}@example.com/r y`)).toBe(`x ${scheme}[redacted]example.com/r y`);
    }
  });

  it("redacts the tail of a password that holds a raw '/' past the old window", () => {
    const pw = `${"Qx9".repeat(1000)}/${"Zy8".repeat(1000)}`;
    expect(clean(`${scheme}svc:${pw}@example.com/r`)).toBe(`${scheme}[redacted]example.com/r`);
  });
});

describe("URL userinfo: accepted limitations stay as documented", () => {
  it("a space or a quote ends the token, so only the part before it is read", () => {
    // Nothing before the space/quote looks like userinfo with a host: left untouched.
    expect(redactSecrets(`${scheme}svc:pa ss@example.com/r`)).toBe(`${scheme}svc:pa ss@example.com/r`);
    expect(redactSecrets(`${scheme}svc:pa"ss@example.com/r`)).toBe(`${scheme}svc:pa"ss@example.com/r`);
    // The tail after the quote is not read as userinfo either: documented leak.
    expect(redactSecrets(`${scheme}svc:pa"ss:Tail9@example.com/r`)).toBe(`${scheme}svc:pa"ss:Tail9@example.com/r`);
  });

  it("a password with '@' and a later delimiter is cut at the last '@' before the delimiter", () => {
    expect(redactSecrets(`${scheme}svc:p@ss/w@host`)).toBe(`${scheme}[redacted]ss/w@host`);
  });
});

describe("userinfoRanges boundaries", () => {
  const start = scheme.length;
  it("returns the [after '://', after '@') range", () => {
    expect(userinfoRanges(`${scheme}u:p@h`)).toEqual([[start, start + 4]]);
  });

  it("'#' ends the authority like '/' and '?': a colon after the fragment start is not userinfo", () => {
    expect(userinfoRanges(`${scheme}host#a:b@c`)).toEqual([]);
    expect(userinfoRanges(`${scheme}host?a:b@c`)).toEqual([]);
    expect(userinfoRanges(`${scheme}host/a:b@c`)).toEqual([]);
    // A password holding '#' before the '@' is still found (colon before the delimiter).
    expect(userinfoRanges(`${scheme}u:p#q@h`)).toEqual([[start, start + 6]]);
  });

  it("a colon must come before the '@'", () => {
    expect(userinfoRanges(`${scheme}user@host:8080/x`)).toEqual([]);
    expect(userinfoRanges(`${scheme}user@host`)).toEqual([]);
    expect(userinfoRanges(`${scheme}u:p@host`)).toHaveLength(1);
  });

  it("finds the same range for passwords just below, at and above 2048 units", () => {
    for (const n of [2046, 2047, 2048, 2049, 2050, 4096]) {
      const text = `${scheme}u:${"p".repeat(n)}@h`;
      expect(userinfoRanges(text)).toEqual([[start, text.length - 1]]);
    }
  });

  it("each scheme is scanned on its own and a range ends the token it belongs to", () => {
    const text = `${scheme}a:b@h ${scheme}c:d@i`;
    expect(userinfoRanges(text)).toEqual([
      [start, start + 4],
      [text.indexOf("c:d") , text.indexOf("c:d") + 4],
    ]);
  });
});

describe("JSON-escaped and percent-encoded text", () => {
  const pw = "Zq7pwX";
  it("redacts URL userinfo in JSON-escaped URLs", () => {
    gone(`{"url":"https:${BS}/${BS}/svc:${pw}@example.com${BS}/r.git"}`, pw);
    gone(`clone https:${BS}/${BS}/svc:${pw}${BS}u0040example.com/r.git`, pw);
    gone(`clone https${BS}u003a${BS}u002f${BS}u002fsvc${BS}u003a${pw}${BS}u0040example.com/r`, pw);
  });

  it("redacts keyword assignments inside an escaped JSON string", () => {
    gone(`{${BS}"pass${"word"}${BS}":${BS}"hunter2secret${BS}"}`, "hunter2secret");
    gone(`{${BS}"api_${"key"}${BS}":${BS}"abc123def456${BS}"}`, "abc123def456");
  });

  it("redacts percent-encoded URLs and assignments", () => {
    gone(`open https%3A%2F%2Fsvc%3A${pw}%40example.com%2Frepo`, pw);
    gone(`open https%3a%2f%2fsvc%3a${pw}%40example.com`, pw);
    gone(`go?next=tok${"en"}%3Dabc123def456&x=1`, "abc123def456");
  });

  it("replaces the whole escaped span and keeps the text around it", () => {
    expect(clean(`see https%3A%2F%2Fsvc%3A${pw}%40example.com%2Frepo ok`)).toBe(`see https%3A%2F%2F[redacted]example.com%2Frepo ok`);
  });

  it("leaves ordinary escapes and encoded URLs without secrets alone", () => {
    for (const text of [
      "open https://example.com/a%2Fb?q=x%3Dy",
      "mail ops%40example.com now",
      `path C:${BS}dir${BS}file.txt and ${BS}"quoted${BS}"`,
      `{"url":"https:${BS}/${BS}/example.com${BS}/docs"}`,
    ]) {
      expect(clean(text)).toBe(text);
    }
  });
});

describe("quoted cookie values", () => {
  it("redacts a double-quoted value with spaces and ';' and the pairs after it", () => {
    const out = clean('Cookie: sid="abc 123; def"; theme=dark; other=zz9 tail');
    expect(out).not.toContain("abc 123");
    expect(out).not.toContain("def");
    expect(out).not.toContain("dark");
    expect(out).toBe("[redacted] tail");
  });

  it("redacts Set-Cookie with a quoted value and an unterminated quote", () => {
    expect(clean('Set-Cookie: auth="Zx9 Qw7"; Path=/')).toBe("Set-[redacted]");
    const out = clean('Cookie: auth="Zx9Qw7Lm2Pq');
    expect(out).not.toContain("Zx9Qw7Lm2Pq");
  });

  it("does not eat prose that mentions cookies", () => {
    expect(clean("the Cookie: banner is shown")).toBe("the Cookie: banner is shown");
  });
});

describe("lone surrogates", () => {
  const high = String.fromCharCode(0xd83d);
  it("a lone surrogate cannot hide a secret", () => {
    gone(`edit ${j("gh", "p_")}${high}${GH_BODY}`, GH_BODY);
    gone(`edit ${j("gh", "p")}${high}_${GH_BODY}`, GH_BODY);
    gone(`${scheme}svc:${high}Zq7pwX@example.com/r`, "Zq7pwX");
  });

  it("is not passed through to the output", () => {
    const low = String.fromCharCode(0xdc00);
    const out = clean(`a${high}b${low}c ${cp(0x1f600)}`);
    expect(out).toBe(`a b c ${cp(0x1f600)}`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  });
});

describe("combining marks hide nothing and are kept in the output (N8)", () => {
  const MC = cp(0x0903); // spacing mark: never stripped before
  const ME = cp(0x20dd); // enclosing mark
  const MN = cp(0x0301);
  for (const [name, mark] of [["Mc", MC], ["Me", ME], ["Mn", MN]] as const) {
    it(`${name} marks inside a keyword, token prefix, JWT, curl and URL scheme`, () => {
      gone(`pass${mark}word=hunter2secret`, "hunter2secret");
      gone(`edit g${mark}hp_${GH_BODY} now`, GH_BODY);
      gone(`edit ${j("gh", "p")}${mark}_${GH_BODY} now`, GH_BODY);
      gone(`${j("ey", "J")}${mark}hbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdef`, "hbGciOiJIUzI1", "eyJzdWIiOiIxMjM0");
      gone(`c${mark}url -u admin:hunter2pw https://example.com`, "hunter2pw");
      gone(`curl${mark} -u admin:hunter2pw https://example.com`, "hunter2pw");
      gone(`ht${mark}tps://deploy:hunter2pw@example.com/r.git`, "hunter2pw");
      gone(`https${mark}://deploy:hunter2pw@example.com/r.git`, "hunter2pw");
      gone(`https://deploy${mark}:hunter2pw${mark}@example.com/r.git`, "hunter2pw");
    });
  }

  it("a letter that NFKC composes with a mark (p + U+0307) still matches its plain form", () => {
    gone(`edit ${j("gh", "p")}${cp(0x307)}_${GH_BODY}`, GH_BODY);
    gone(`edit ${j("gh")}${cp(0x1e57)}_${GH_BODY}`, GH_BODY);
    gone(`edit ${cp(0x1e61)}k-abcdefghijklmnop1234`, "abcdefghij");
  });

  it("keeps the marks of ordinary text (Hindi, Thai, Arabic with harakat)", () => {
    for (const text of ["हिन्दी", "ภาษาไทย", "العَرَبِيَّة", "cafe" + MN, "x" + ME]) {
      expect(clean(text)).toBe(text.normalize("NFKC"));
    }
  });

  it("keeps the marks around a redacted span", () => {
    expect(clean(`हिन्दी ${j("gh", "p_")}${GH_BODY} हिन्दी`)).toBe("हिन्दी [redacted] हिन्दी");
  });
});

describe("curl -u forms", () => {
  it("redacts an empty user and a long flag cluster before u", () => {
    gone("curl -u :hunter2pw https://example.com", "hunter2pw");
    gone("curl -s -u:hunter2pw https://example.com", "hunter2pw");
    gone("curl -sSLkvfiOZu admin:hunter2pw https://example.com", "hunter2pw"); // 9 letters before u
    gone("curl -sSLkvfiOZuadmin:hunter2pw https://example.com", "hunter2pw");
  });

  it("leaves a lone -u user and unrelated flags alone", () => {
    for (const text of ["curl -u admin https://example.com", "curl -sSLkvfiOZ https://example.com", "curl -H x:y https://example.com"]) {
      expect(clean(text)).toBe(text);
    }
  });
});

describe("braille blank", () => {
  it("is dropped from the output and cannot hide a secret", () => {
    expect(clean(`a${cp(0x2800)}b`)).toBe("ab");
    gone(`${j("gh", "p_")}${cp(0x2800)}${GH_BODY}`, GH_BODY);
  });
});

describe("over-redaction set stays green", () => {
  it("keeps paths, SHAs, prose, plain URLs, emails and non-Latin text intact", () => {
    for (const text of [
      "src/core/translate.ts and test/core/redact.test.ts",
      "git commit abcdef0123456789abcdef0123456789abcdef01",
      "fix tok" + "en: handling in auth",
      "src/sk-utils-helper.ts",
      "see https://example.com:8080/path/a@b and https://example.com/docs#frag",
      "mail ops@example.com or dev@example.org: thanks @team",
      "ssh://github.com:22/org/repo.git",
      "open http://localhost:3000/ui?x=1#top",
      "это обычный текст 日本語のテキスト",
      "file C:" + BS + "Users" + BS + "dev" + BS + "a.ts",
      "Cookie banner and session expired",
    ]) {
      expect(clean(text)).toBe(text);
    }
  });
});

describe("cost stays linear at 100k and 500k units (AC-3)", () => {
  const SPLIT_LIMIT_MS = 5000;
  const LIMIT_MS = 1500; // linear: tens of ms; a rescanning (quadratic) cursor needs many seconds
  const shapes: Array<[string, string]> = [
    ["bare schemes, no whitespace", scheme],
    ["scheme and colon", `${scheme}a:`],
    ["scheme user '@' pairs", `${scheme}a@`],
    ["scheme user:pw@ with spaces", `${scheme}a:b@h `],
    ["scheme with delimiter and fallback '@'", `${scheme}a:b/${scheme}c@`],
    ["scheme '@' colon slash noise", "a://@x@:/"],
    ["digits and delimiters", `${scheme}h:12/`],
    ["hidden marks inside userinfo", `${scheme}d${cp(0x301)}e:p${cp(0x301)}@h `],
  ];
  for (const [name, unit] of shapes) {
    for (const size of [100_000, 500_000]) {
      it(`userinfoRanges + redactSecrets: ${name} (${size / 1000}k)`, () => {
        const input = unit.repeat(Math.ceil(size / unit.length));
        const start = performance.now();
        userinfoRanges(input);
        redactSecrets(input);
        expect(performance.now() - start).toBeLessThan(LIMIT_MS);
      });
    }
  }

  const split: Array<[string, string]> = [
    ["hidden characters between schemes", `${scheme}${cp(0x200b)}u:p@h `],
    ["escaped URLs", `https%3A%2F%2Fu%3Ap%40h `],
    ["JSON-escaped quotes", `${BS}"a${BS}":${BS}"b${BS}" `],
    ["marks everywhere", `a${cp(0x301)}${cp(0x903)}`],
    ["repeated keyword", j("tok", "en")],
    ["repeated cookie header", 'Cookie: a="b c"; '],
  ];
  for (const [name, unit] of split) {
    for (const size of [100_000, 500_000]) {
      it(`redactSplitSecrets + redactDetail: ${name} (${size / 1000}k)`, () => {
        const input = unit.repeat(Math.ceil(size / unit.length));
        const start = performance.now();
        redactSplitSecrets(input);
        redactDetail(input);
        // Linear but heavier (decode, NFKD, span maps): about 3 us per unit at 500k; quadratic needs minutes.
        expect(performance.now() - start).toBeLessThan(SPLIT_LIMIT_MS);
      });
    }
  }
});

type InlineMathSegment = {
  type: "text" | "math";
  value: string;
};

const STYLE_COMMANDS =
  "mathbb|mathcal|mathfrak|mathscr|mathbf|mathit|mathrm|mathsf";

const COMMAND_MAP: Record<string, string> = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  vartheta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  varpi: "pi",
  rho: "rho",
  varrho: "rho",
  sigma: "sigma",
  varsigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  varphi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "Gamma",
  Delta: "Delta",
  Theta: "Theta",
  Lambda: "Lambda",
  Xi: "Xi",
  Pi: "Pi",
  Sigma: "Sigma",
  Upsilon: "Upsilon",
  Phi: "Phi",
  Psi: "Psi",
  Omega: "Omega",
  infty: "inf",
  cdot: "*",
  times: "x",
  to: "->",
  rightarrow: "->",
  leftarrow: "<-",
  leftrightarrow: "<->",
  Rightarrow: "=>",
  Leftarrow: "<=",
  Leftrightarrow: "<=>",
  mapsto: "->",
  geq: ">=",
  leq: "<=",
  neq: "!=",
  approx: "~",
  sim: "~",
  propto: "propto",
  mid: "|",
  sum: "sum",
  prod: "prod",
  max: "max",
  min: "min",
  argmax: "argmax",
  argmin: "argmin",
  in: "in",
  notin: "notin",
  cup: "cup",
  cap: "cap",
  log: "log",
  ln: "ln",
  exp: "exp",
  Pr: "Pr",
  forall: "forall",
  exists: "exists",
  partial: "partial",
  nabla: "nabla",
  cdots: "...",
  ldots: "...",
  vdots: "...",
  ddots: "...",
  pm: "+/-",
  mp: "-/+",
  ell: "ell",
  left: "",
  right: "",
};

export function renderLatexToText(source: string): string {
  let text = source;

  text = text.replace(/\\\\/g, "\n");

  text = text.replace(/\\left\b/g, "");
  text = text.replace(/\\right\b/g, "");

  text = text.replace(/\\text\s*\{([^}]*)\}/g, "$1");
  text = text.replace(
    new RegExp(`\\\\(${STYLE_COMMANDS})\\s*\\{([^}]*)\\}`, "g"),
    "$2",
  );
  text = text.replace(
    new RegExp(`\\\\(${STYLE_COMMANDS})\\s+([A-Za-z0-9])`, "g"),
    "$2",
  );

  text = text.replace(/\\qquad\b/g, "    ");
  text = text.replace(/\\quad\b/g, "  ");
  text = text.replace(/\\,/g, " ");
  text = text.replace(/\\;/g, " ");
  text = text.replace(/\\:/g, " ");
  text = text.replace(/\\!/g, "");

  text = text.replace(/\\\{/g, "{");
  text = text.replace(/\\\}/g, "}");
  text = text.replace(/\\%/g, "%");
  text = text.replace(/\\_/g, "_");
  text = text.replace(/\\#/g, "#");
  text = text.replace(/\\&/g, "&");
  text = text.replace(/\\\$/g, "$");

  text = text.replace(/\\([A-Za-z]+)\b/g, (match, name) => {
    const replacement = COMMAND_MAP[name];
    return replacement ?? match;
  });

  return text;
}

function findNextMathStart(
  text: string,
  startIndex: number,
): { index: number; delimiter: "$" | "$$" | "\\(" | "\\[" } | null {
  for (let i = startIndex; i < text.length; i++) {
    const current = text[i];
    if (current === "\\") {
      const next = text[i + 1];
      if (next === "(") {
        return { index: i, delimiter: "\\(" };
      }
      if (next === "[") {
        return { index: i, delimiter: "\\[" };
      }
      if (next === "$") {
        i += 1;
        continue;
      }
    }
    if (current === "$") {
      if (i > 0 && text[i - 1] === "\\") {
        continue;
      }
      if (text[i + 1] === "$") {
        return { index: i, delimiter: "$$" };
      }
      return { index: i, delimiter: "$" };
    }
  }

  return null;
}

function findMathClose(
  text: string,
  startIndex: number,
  delimiter: "$" | "$$" | "\\(" | "\\[",
): number {
  if (delimiter === "$") {
    for (let i = startIndex; i < text.length; i++) {
      if (text[i] !== "$") continue;
      if (i > 0 && text[i - 1] === "\\") continue;
      if (text[i + 1] === "$") continue;
      return i;
    }
    return -1;
  }

  if (delimiter === "$$") {
    let searchIndex = startIndex;
    while (searchIndex < text.length) {
      const found = text.indexOf("$$", searchIndex);
      if (found === -1) return -1;
      if (found === 0 || text[found - 1] !== "\\") {
        return found;
      }
      searchIndex = found + 2;
    }
    return -1;
  }

  if (delimiter === "\\(") {
    return text.indexOf("\\)", startIndex);
  }

  return text.indexOf("\\]", startIndex);
}

export function splitInlineMathSegments(text: string): InlineMathSegment[] {
  const segments: InlineMathSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const next = findNextMathStart(text, cursor);
    if (!next) {
      const remainder = text.slice(cursor);
      if (remainder) {
        segments.push({ type: "text", value: remainder });
      }
      break;
    }

    if (next.index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, next.index) });
    }

    const closeIndex = findMathClose(
      text,
      next.index + next.delimiter.length,
      next.delimiter,
    );
    if (closeIndex === -1) {
      segments.push({
        type: "text",
        value: text.slice(next.index, next.index + next.delimiter.length),
      });
      cursor = next.index + next.delimiter.length;
      continue;
    }

    segments.push({
      type: "math",
      value: text.slice(next.index + next.delimiter.length, closeIndex),
    });

    const closeLength = next.delimiter.length;
    cursor = closeIndex + closeLength;
  }

  return segments;
}

/** The demo conversations: written to look like real use, for a fresh install and the README screenshots. */

export interface DemoSource {
  title: string;
  url: string;
  snippet: string;
}

export interface DemoTurn {
  user: string;
  /** An image the user attached (an SVG scene rendered to PNG). */
  attachImage?: keyof typeof SCENES;
  /** A document the user attached. */
  attachDoc?: { name: string; text: string };
  assistant: string;
  model?: "main" | "lite";
  sources?: DemoSource[];
  steps?: { tool: "web_search" | "open_url" | "generate_image" | "remember" | "search_project_files"; label: string }[];
  /** The assistant made this image. */
  image?: { scene: keyof typeof SCENES; prompt: string };
  feedback?: 1 | -1;
  /** A regenerated answer kept as a sibling branch (shown as 1 / 2). */
  alternative?: { assistant: string; model?: "main" | "lite" };
}

export interface DemoConversation {
  title: string;
  hoursAgo: number;
  pinned?: boolean;
  project?: "launch";
  turns: DemoTurn[];
}

export const SCENES = {
  lighthouse: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset="0.55" stop-color="#d9735b"/><stop offset="1" stop-color="#f6c38a"/></linearGradient>
      <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c4a6b"/><stop offset="1" stop-color="#0d1b2e"/></linearGradient>
      <radialGradient id="beam" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff7d6" stop-opacity="0.9"/><stop offset="1" stop-color="#fff7d6" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="1024" height="1024" fill="url(#sky)"/>
    <circle cx="760" cy="560" r="70" fill="#ffd9a0" opacity="0.85"/>
    <rect y="620" width="1024" height="404" fill="url(#sea)"/>
    <path d="M0 640 Q256 610 512 640 T1024 640 V660 H0Z" fill="#3c5f86" opacity="0.6"/>
    <path d="M170 700 L420 600 L520 640 L620 700Z" fill="#141c2b"/>
    <polygon points="330,330 370,330 392,610 308,610" fill="#f3efe6"/>
    <rect x="315" y="420" width="70" height="26" fill="#b5413a"/><rect x="306" y="520" width="88" height="28" fill="#b5413a"/>
    <rect x="322" y="292" width="56" height="40" fill="#1d2433"/><polygon points="314,292 386,292 350,250" fill="#b5413a"/>
    <ellipse cx="350" cy="312" rx="300" ry="60" fill="url(#beam)" transform="rotate(-12 350 312)"/>
    <circle cx="350" cy="312" r="16" fill="#fff4c2"/>
    <g fill="#fff" opacity="0.7"><circle cx="120" cy="120" r="2"/><circle cx="220" cy="80" r="1.5"/><circle cx="880" cy="140" r="2"/><circle cx="640" cy="90" r="1.5"/></g>
  </svg>`,
  whiteboard: `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
    <rect width="1200" height="800" fill="#e9e6df"/><rect x="40" y="40" width="1120" height="720" rx="10" fill="#fbfbf8" stroke="#c9c5bb" stroke-width="6"/>
    <g font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#1f3a8a">
      <rect x="110" y="140" width="250" height="110" rx="14" fill="none" stroke="#1f3a8a" stroke-width="5"/><text x="150" y="208">Browser</text>
      <rect x="480" y="140" width="250" height="110" rx="14" fill="none" stroke="#1f3a8a" stroke-width="5"/><text x="530" y="208">API</text>
      <rect x="850" y="140" width="250" height="110" rx="14" fill="none" stroke="#1f3a8a" stroke-width="5"/><text x="880" y="208">Postgres</text>
      <rect x="480" y="460" width="250" height="110" rx="14" fill="none" stroke="#b91c1c" stroke-width="5"/><text x="530" y="528" fill="#b91c1c">Redis</text>
    </g>
    <g stroke="#1f3a8a" stroke-width="5" fill="none"><path d="M360 195 H470"/><path d="M730 195 H840"/><path d="M605 250 V450" stroke="#b91c1c"/></g>
    <g fill="#1f3a8a"><polygon points="470,185 490,195 470,205"/><polygon points="840,185 860,195 840,205"/><polygon points="595,450 605,470 615,450" fill="#b91c1c"/></g>
    <text x="640" y="360" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#b91c1c">cache?</text>
  </svg>`,
  poster: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e99ad"/><stop offset="1" stop-color="#0b1220"/></linearGradient></defs>
    <rect width="1024" height="1024" fill="url(#g)"/>
    <g fill="none" stroke="#7fe3f0" stroke-opacity="0.35" stroke-width="2"><circle cx="760" cy="260" r="120"/><circle cx="760" cy="260" r="190"/><circle cx="760" cy="260" r="260"/></g>
    <path d="M150 760 C300 620 420 700 520 560 S760 420 880 300" stroke="#f4f7fb" stroke-width="10" fill="none" stroke-linecap="round"/>
    <circle cx="880" cy="300" r="22" fill="#f4f7fb"/>
    <rect x="150" y="820" width="420" height="16" rx="8" fill="#f4f7fb" opacity="0.9"/><rect x="150" y="856" width="280" height="12" rx="6" fill="#f4f7fb" opacity="0.5"/>
  </svg>`,
} as const;

const HTTPS = `HTTPS is HTTP sent through an encrypted, authenticated tunnel (TLS). Here is what happens when you open \`https://example.com\`:

1. **TCP connection.** Your browser connects to the server on port 443.
2. **TLS handshake.** The browser says which TLS versions and ciphers it supports; the server answers with its choice and its **certificate**.
3. **Certificate check.** The browser verifies the certificate was signed by a certificate authority it trusts, that it is for \`example.com\`, and that it has not expired.
4. **Key exchange.** Both sides use (EC)DHE to agree on a fresh secret without ever sending it. This gives *forward secrecy*: a key stolen later cannot decrypt today's traffic.
5. **Encrypted HTTP.** Requests and responses now travel encrypted with a symmetric cipher such as AES-GCM or ChaCha20-Poly1305.

| What TLS gives you | What it does not hide |
| --- | --- |
| Confidentiality of URLs paths, headers and bodies | The server's IP address |
| Integrity: tampering is detected | The domain name (SNI), unless ECH is used |
| Authentication of the server | How much data you send, and when |

With TLS 1.3 the whole handshake takes a single round trip, so the security costs almost nothing in speed.`;

const HOOK_Q = `Why does this hook fire twice and then show stale data?

\`\`\`tsx
function useUser(id: string) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    fetch(\`/api/users/\${id}\`).then((r) => r.json()).then(setUser);
  }, []);
  return user;
}
\`\`\``;

const HOOK_A = `Two separate issues:

**1. It runs twice in development.** React 18+ Strict Mode mounts, unmounts and remounts every component once in development to surface effects that do not clean up. In production it runs once. That part is expected.

**2. The stale data is a real bug.** The dependency array is empty, so the effect never re-runs when \`id\` changes, and a slow response for an old \`id\` can still land after a newer one. Fix both with the id in the dependencies and a cancellation flag:

\`\`\`tsx
function useUser(id: string) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(\`/api/users/\${id}\`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setUser)
      .catch((err) => {
        if (err.name !== "AbortError") throw err;
      });
    return () => controller.abort();
  }, [id]);
  return user;
}
\`\`\`

The cleanup aborts the previous request whenever \`id\` changes or the component unmounts, so only the latest response is ever stored. If you fetch in many places, TanStack Query handles this (plus caching and retries) for you.`;

const HOOK_A_ALT = `The effect has an empty dependency array, so it captures the first \`id\` and never updates: add \`id\` to the array. The double call you see is React Strict Mode re-running effects in development; it disappears in production builds.

\`\`\`tsx
useEffect(() => {
  let active = true;
  fetch(\`/api/users/\${id}\`).then((r) => r.json()).then((u) => active && setUser(u));
  return () => {
    active = false;
  };
}, [id]);
\`\`\``;

const BATTERIES = `Solid-state batteries are moving from labs to pilot lines, but mass-market cars are still a few years out.

- **Where things stand.** Several manufacturers run pilot production of cells with solid electrolytes and report energy densities well above today's lithium-ion cells [1].
- **The hard parts.** Making the solid electrolyte thin, defect-free and cheap at scale, and keeping good contact between layers as the cell expands and contracts while charging [2].
- **Timelines.** Most announced plans put small production volumes in premium vehicles first, with broader use later in the decade [1][3].

If you are deciding on a car purchase now, solid-state should not be a factor yet: today's lithium-ion and LFP packs keep improving in price and range.`;

const INTEREST = `With compound interest the balance grows by a fixed percentage each period:

$$A = P\\left(1 + \\frac{r}{n}\\right)^{nt}$$

where $P$ is the principal, $r$ the yearly rate, $n$ the number of compounding periods per year, and $t$ the number of years.

For **10,000 at 6% compounded monthly for 10 years**:

$$A = 10000 \\left(1 + \\frac{0.06}{12}\\right)^{120} \\approx 18{,}194$$

So the money grows by about 82%. Compounded yearly instead it would be $10000 \\times 1.06^{10} \\approx 17{,}908$: more frequent compounding helps, but less than people expect.`;

export const LAUNCH_DOC = {
  name: "q3-launch-brief.md",
  text: `# Q3 launch brief: Team Workspaces

## Goal
Ship shared team workspaces to every paid plan by 15 September. Success means 30% of active teams create a workspace in the first 30 days.

## Scope
- Shared folders with per-member roles (owner, editor, viewer)
- Activity feed per workspace
- Migration of existing personal folders, opt-in per team

Out of scope for Q3: guest access, workspace-level billing, the public API.

## Timeline
- 1 July: design review signed off
- 29 July: private beta with 20 design partners
- 26 August: public beta behind a flag
- 15 September: general availability

## Risks
1. Migration of large personal folders may time out. Mitigation: background job with progress, resumable.
2. Role model confusion with the existing sharing dialog. Mitigation: one sharing dialog for both, usability test in beta.
3. Support load at GA. Mitigation: help centre articles and a two-week support rota.

## Owners
Product: Priya. Engineering: Leo. Design: Sam. Support: the customer success team.`,
};

export const CONVERSATIONS: DemoConversation[] = [
  {
    title: "How HTTPS works",
    hoursAgo: 0.6,
    pinned: true,
    turns: [{ user: "Explain how HTTPS works, step by step. Keep it practical.", assistant: HTTPS, feedback: 1 }],
  },
  {
    title: "React hook runs twice",
    hoursAgo: 2,
    turns: [{ user: HOOK_Q, assistant: HOOK_A, alternative: { assistant: HOOK_A_ALT, model: "lite" } }],
  },
  {
    title: "Solid-state batteries in 2026",
    hoursAgo: 5,
    turns: [
      {
        user: "What's the latest on solid-state batteries for cars? Search the web.",
        assistant: BATTERIES,
        steps: [
          { tool: "web_search", label: 'Found 6 results for "solid-state batteries cars 2026"' },
          { tool: "open_url", label: "Read example.org" },
        ],
        sources: [
          { title: "Solid-state cells reach pilot production", url: "https://example.org/news/solid-state-pilot-lines", snippet: "Pilot lines report energy densities well above current lithium-ion cells." },
          { title: "Why solid electrolytes are hard to manufacture", url: "https://example.com/research/solid-electrolyte-manufacturing", snippet: "Thin, defect-free electrolyte layers remain the main cost driver." },
          { title: "Automaker battery roadmaps compared", url: "https://example.net/analysis/battery-roadmaps", snippet: "Most plans start with premium models in small volumes." },
        ],
      },
    ],
  },
  {
    title: "Launch risks from the brief",
    hoursAgo: 8,
    project: "launch",
    turns: [
      {
        user: "From the launch brief in this project, what are the top risks and who owns the mitigation?",
        steps: [{ tool: "search_project_files", label: "Found 3 passages in your files" }],
        assistant: `The brief lists three risks (q3-launch-brief.md, "Risks"):

| Risk | Mitigation | Likely owner |
| --- | --- | --- |
| Large personal folders time out during migration | A resumable background job with progress | Engineering (Leo) |
| Confusion between the new roles and the existing sharing dialog | One sharing dialog for both, usability-tested in the beta | Design (Sam) |
| Support load at general availability | Help centre articles and a two-week support rota | Customer success |

The brief names owners per function, not per risk, so the owners above are inferred from the "Owners" section. Worth confirming in the design review on 1 July.`,
      },
      { user: "Draft a two-line status update for the leadership channel.", assistant: "**Team Workspaces, week 27:** design review is on track for 1 July and 14 of 20 beta partners are confirmed. Main risk is migration of very large folders; a resumable job is in progress." },
    ],
  },
  {
    title: "Lighthouse at dusk",
    hoursAgo: 26,
    turns: [{ user: "Draw a lighthouse at dusk, flat illustration style, warm sky, calm sea.", assistant: "Here is your lighthouse at dusk.", steps: [{ tool: "generate_image", label: "Created an image" }], image: { scene: "lighthouse", prompt: "A lighthouse at dusk, flat illustration style, warm gradient sky, calm sea, a soft beam of light" } }],
  },
  {
    title: "Whiteboard architecture",
    hoursAgo: 30,
    turns: [
      {
        user: "This is from our planning session. Is the cache in the right place?",
        attachImage: "whiteboard",
        assistant: `The sketch shows **Browser → API → Postgres**, with **Redis** hanging off the API and a question mark next to it. That placement is right for most apps:

- The API checks Redis first and falls back to Postgres on a miss (cache-aside), so the browser never talks to Redis directly.
- Cache what is read often and changes rarely: sessions, rate-limit counters, rendered fragments, expensive aggregates.
- Decide how entries are invalidated before you add them: a TTL for data that can be slightly stale, explicit deletes on write for data that cannot.

One thing missing from the board: what happens when Redis is down. Make every cache read fail open to Postgres so an outage slows the app instead of breaking it.`,
      },
    ],
  },
  {
    title: "Compound interest formula",
    hoursAgo: 50,
    turns: [{ user: "What's the compound interest formula? Show 10,000 at 6% for 10 years.", assistant: INTEREST }],
  },
  {
    title: "Launch poster concept",
    hoursAgo: 52,
    project: "launch",
    turns: [{ user: "Draw a minimal poster concept for the workspaces launch: teal, a rising path, lots of space.", assistant: "A first concept for the poster.", steps: [{ tool: "generate_image", label: "Created an image" }], image: { scene: "poster", prompt: "Minimal launch poster, teal to navy gradient, a single rising path ending in a dot, concentric rings, generous negative space" } }],
  },
  { title: "Lisbon in three days", hoursAgo: 75, turns: [{ user: "Plan three relaxed days in Lisbon in October.", assistant: "**Day 1: Alfama and the castle.** Walk up through Alfama in the morning, castle at opening time, lunch at a tasca, sunset at a miradouro.\n\n**Day 2: Belém.** Tower, monastery and the riverside, with the custard tarts the area is known for.\n\n**Day 3: Sintra (day trip).** Train from Rossio, Pena Palace first, then the Moorish Castle.\n\nOctober is mild (about 22°C), so plan on layers and good shoes: the hills are steep." }] },
  { title: "SQL window functions", hoursAgo: 98, turns: [{ user: "When should I use a window function instead of GROUP BY?", assistant: "Use **GROUP BY** when you want one row per group. Use a **window function** when you want to keep every row and add a value computed over its group:\n\n```sql\nSELECT order_id, customer_id, total,\n       sum(total) OVER (PARTITION BY customer_id) AS customer_total,\n       rank() OVER (PARTITION BY customer_id ORDER BY total DESC) AS rank_in_customer\nFROM orders;\n```\n\nTypical uses: running totals, rankings, moving averages, and comparing a row with the previous one (`lag`)." }] },
  { title: "Cover letter opening", hoursAgo: 140, turns: [{ user: "Write a strong first paragraph for a product designer cover letter. Not cheesy.", assistant: "I design tools people use for hours a day, so I care about the details that only show up in the hundredth session: the shortcut that saves a second, the empty state that explains itself, the error that tells you what to do next. Over the last five years I have shipped design systems and editors used by teams of every size, and I would like to bring that patience to your product." }] },
  { title: "Liveness vs readiness probes", hoursAgo: 190, turns: [{ user: "Kubernetes liveness vs readiness probe, in two sentences.", assistant: "A **readiness** probe decides whether a pod receives traffic: failing it takes the pod out of the load balancer without restarting it. A **liveness** probe decides whether the container is stuck: failing it restarts the container, so it should only check the process itself, never its dependencies." }] },
  { title: "Transformers for a 10-year-old", hoursAgo: 260, turns: [{ user: "Explain transformers (the AI kind) to a 10-year-old.", assistant: "Imagine reading a story and, for every word, quickly looking back at all the other words to see which ones help you understand it. In \"The dog chased the ball because **it** was bouncing\", you look back and decide \"it\" means the ball.\n\nA transformer does exactly that, for every word at once, millions of times, after practising on a giant pile of text. Doing that \"looking back\" really well is what lets it write sentences that make sense." }] },
  { title: "Regex for UK postcodes", hoursAgo: 400, turns: [{ user: "Regex for UK postcodes?", assistant: "A practical pattern that accepts the common formats (case-insensitive, optional space):\n\n```regex\n^[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}$\n```\n\nIt allows a few combinations that are not real postcodes, which is usually fine for form validation. For certainty, look the postcode up against an address service." }] },
];

export const MEMORIES = [
  "Works as a product manager on a collaboration tool.",
  "Prefers concise answers with tables when comparing options.",
  "Writes code mostly in TypeScript and React.",
  "Based in Europe; uses metric units and 24-hour time.",
];

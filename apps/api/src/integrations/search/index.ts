/**
 * Web search behind one function. SearXNG is the default in deploy/compose: a
 * self-hosted metasearch engine, so queries never leave infrastructure you run and no
 * key is needed. Tavily, Exa and Brave are drop-in hosted alternatives; `stub` returns
 * fixed results from apps/stubs for tests.
 *
 * Every provider's results are normalised to the same small shape, and snippets are
 * trimmed: search output goes to the model as a tool result (data), never into the
 * system prompt.
 */
import { config } from "../../core/config";
import { ProviderError, providerFetch, withTimeout } from "../http";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

const MAX_RESULTS = 6;
const SNIPPET_CHARS = 700;

function clip(s: string | undefined | null, n = SNIPPET_CHARS): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function onlyHttp(hits: SearchHit[]): SearchHit[] {
  return hits.filter((h) => /^https?:\/\//i.test(h.url)).slice(0, MAX_RESULTS);
}

export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const s = withTimeout(signal, 15_000);
  switch (config.SEARCH_PROVIDER) {
    case "searxng": {
      const url = `${(config.SEARXNG_URL ?? "").replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
      const res = await providerFetch("searxng", url, { headers: { Accept: "application/json" }, signal: s });
      const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string; publishedDate?: string | null }[] };
      return onlyHttp((json.results ?? []).map((r) => ({ title: clip(r.title, 200), url: r.url ?? "", snippet: clip(r.content), publishedAt: r.publishedDate ?? null })));
    }
    case "tavily": {
      const res = await providerFetch("tavily", "https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.TAVILY_API_KEY}` },
        body: JSON.stringify({ query, max_results: MAX_RESULTS, search_depth: "basic" }),
        signal: s,
      });
      const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
      return onlyHttp((json.results ?? []).map((r) => ({ title: clip(r.title, 200), url: r.url ?? "", snippet: clip(r.content), publishedAt: r.published_date ?? null })));
    }
    case "exa": {
      const res = await providerFetch("exa", "https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.EXA_API_KEY ?? "" },
        body: JSON.stringify({ query, numResults: MAX_RESULTS, contents: { text: { maxCharacters: SNIPPET_CHARS } } }),
        signal: s,
      });
      const json = (await res.json()) as { results?: { title?: string; url?: string; text?: string; publishedDate?: string }[] };
      return onlyHttp((json.results ?? []).map((r) => ({ title: clip(r.title, 200), url: r.url ?? "", snippet: clip(r.text), publishedAt: r.publishedDate ?? null })));
    }
    case "brave": {
      const res = await providerFetch("brave", `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`, {
        headers: { Accept: "application/json", "X-Subscription-Token": config.BRAVE_API_KEY ?? "" },
        signal: s,
      });
      const json = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string; page_age?: string }[] } };
      return onlyHttp((json.web?.results ?? []).map((r) => ({ title: clip(r.title, 200), url: r.url ?? "", snippet: clip(r.description?.replace(/<[^>]+>/g, "")), publishedAt: r.page_age ?? null })));
    }
    case "stub": {
      const res = await providerFetch("stub-search", `${config.STUBS_URL.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}`, { signal: s });
      const json = (await res.json()) as { results?: SearchHit[] };
      return onlyHttp(json.results ?? []);
    }
    case "none":
      throw new ProviderError("UNAVAILABLE", "search");
  }
}

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@open-chat/ui";
import type { ChatSettings, IntegrationStatus, QuotaTier } from "@open-chat/types";

// jsdom has no ResizeObserver; Radix switches measure themselves with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const admin = {
  tiers: vi.fn<() => Promise<QuotaTier[]>>(),
  settings: vi.fn<() => Promise<ChatSettings>>(),
  updateSettings: vi.fn<(b: Partial<ChatSettings>) => Promise<ChatSettings>>(),
  integrations: vi.fn<() => Promise<IntegrationStatus>>(),
};
vi.mock("@/lib/api", () => ({ api: () => ({ admin }) }));

import { AdminQuotas } from "@/components/admin/pages/quotas";
import { AdminSettings } from "@/components/admin/pages/settings";

const settings: ChatSettings = {
  appName: "Team Chat",
  tagline: "Ask anything",
  registration: "OPEN",
  allowedEmailDomains: [],
  supportEmail: null,
  systemPromptAddendum: "",
  features: { webSearch: true, imageGeneration: true, dictation: true, readAloud: true, memory: true, projects: true, sharing: true },
  defaults: { answerStyle: "BALANCED" },
  retentionDays: null,
  minSupportedVersion: null,
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.integrations.mockResolvedValue({ search: { provider: "stub", configured: true }, moderation: { provider: "none" }, speech: { transcribe: true, tts: false }, mail: { mode: "outbox" }, storage: { mode: "local" } });
});

describe("quotas page", () => {
  it("lists tiers with Unlimited and the default marker", async () => {
    admin.tiers.mockResolvedValue([
      { id: "t1", name: "Default", dailyTokens: 200000, dailyImages: 20, maxFileMb: 25, isDefault: true, userCount: 4 },
      { id: "t2", name: "Staff", dailyTokens: null, dailyImages: null, maxFileMb: 100, isDefault: false, userCount: 1 },
    ]);
    wrap(<AdminQuotas />);
    const staff = await screen.findByTestId("tier-row-Staff");
    expect(within(staff).getAllByText("Unlimited").length).toBe(2);
    const def = screen.getByTestId("tier-row-Default");
    expect(within(def).getByText("Default", { selector: "span.inline-flex" })).toBeInTheDocument();
    expect(within(def).getByText("25 MB")).toBeInTheDocument();
  });
});

describe("settings page", () => {
  it("saves only what changed", async () => {
    admin.settings.mockResolvedValue(settings);
    admin.updateSettings.mockImplementation(async (b) => ({ ...settings, ...b, features: { ...settings.features, ...(b.features ?? {}) } }));
    const user = userEvent.setup();
    wrap(<AdminSettings />);
    const memory = await screen.findByTestId("settings-feature-memory");
    expect(screen.queryByTestId("settings-save-bar")).not.toBeInTheDocument();
    await user.click(memory);
    expect(await screen.findByText(/Unsaved changes in Features/)).toBeInTheDocument();
    await user.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(admin.updateSettings).toHaveBeenCalledWith({ features: { memory: false } }));
  });

  it("blocks invite-only sign-up without a domain", async () => {
    admin.settings.mockResolvedValue({ ...settings, registration: "INVITE_ONLY", allowedEmailDomains: ["example.com"] });
    const user = userEvent.setup();
    wrap(<AdminSettings />);
    const list = await screen.findByTestId("settings-domains");
    await user.click(within(list).getByRole("button", { name: "Remove example.com" }));
    expect(await screen.findByText("Invite-only sign-up needs at least one allowed domain.")).toBeInTheDocument();
    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("shows integrations read-only", async () => {
    admin.settings.mockResolvedValue(settings);
    wrap(<AdminSettings />);
    expect(await screen.findByText("Local stub")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Outbox: written to disk on the server, not sent")).toBeInTheDocument();
  });
});

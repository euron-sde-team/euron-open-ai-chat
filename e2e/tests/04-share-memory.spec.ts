import { expect, test } from "@playwright/test";
import { newContext, newUser, pageFor, send } from "../helpers";

test("a shared link opens signed out and does not show later messages", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await send(page, "Hello there, first message");
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const url = await page.getByLabel("Share link").inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  await send(page, "A private follow-up");

  const anon = await (await newContext(browser)).newPage();
  await anon.goto(url);
  await expect(anon.getByText("Shared by")).toBeVisible();
  await expect(anon.getByText("Hello there, first message", { exact: true }).first()).toBeVisible();
  await expect(anon.getByText("A private follow-up")).toHaveCount(0);
  await anon.context().close();
  await page.context().close();
});

test("the assistant remembers, and you can see and delete the memory", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await send(page, "Please remember that I prefer metric units");
  await expect(page.getByTestId("assistant-message").last()).toContainText("Memory updated");
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Memory" }).click();
  const item = page.getByRole("listitem").filter({ hasText: "metric units" });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Forget" }).click();
  await expect(item).toHaveCount(0);
  await page.context().close();
});

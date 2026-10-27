import { expect, test } from "@playwright/test";
import { newUser, pageFor, pngBytes, send, waitForAnswer } from "../helpers";

test("web search shows its steps, numbered citations and the sources list", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await send(page, "Search the latest news about tidal power");
  const answer = page.getByTestId("assistant-message").last();
  await expect(answer).toContainText(/Found \d+ results/);
  await expect(answer.getByRole("link", { name: "Source 1" })).toBeVisible();
  await expect(answer.getByText("Sources", { exact: true })).toBeVisible();
  await page.context().close();
});

test("an attached image reaches a vision model", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await page.locator('input[type="file"]').first().setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pngBytes(64) });
  await expect(page.getByRole("button", { name: "Remove photo.png" })).toBeAttached();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel("Message", { exact: true }).fill("What is in this picture?");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForAnswer(page);
  await expect(page.getByTestId("assistant-message").last()).toContainText("I can see 1 image");
  await expect(page.getByTestId("user-message").getByRole("button", { name: "Open photo.png" })).toBeVisible();
  await page.context().close();
});

test("the assistant draws an image in the chat, and it lands in the gallery", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await send(page, "Draw a picture of a red fox in snow");
  await expect(page.getByTestId("assistant-message").last().getByRole("button", { name: "Open image" })).toBeVisible();
  await page.goto("/images");
  await expect(page.getByRole("button", { name: /Open: Draw a picture of a red fox/ })).toBeVisible();
  await page.context().close();
});

test("a project file is searched when a question needs it", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Name").fill("Launch notes");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/projects\//);
  await page.locator('input[type="file"]').last().setInputFiles({ name: "brief.md", mimeType: "text/markdown", buffer: Buffer.from("# Brief\n\nThe launch date is 15 September. The owner is Leo.\n") });
  await expect(page.getByText("brief.md")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Message", { exact: true }).fill("What does the document in my project say about the launch?");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForAnswer(page);
  await expect(page.getByTestId("assistant-message").last()).toContainText(/passages in your files/);
  await page.context().close();
});

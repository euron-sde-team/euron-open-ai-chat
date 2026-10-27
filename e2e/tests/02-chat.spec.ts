import { expect, test } from "@playwright/test";
import { newUser, pageFor, send, waitForAnswer } from "../helpers";

test("a new chat streams an answer, gets a title, and survives a reload", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);

  await test.step("the empty state greets by first name", async () => {
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  });

  await test.step("sending moves to /c/:id and the answer streams in", async () => {
    await send(page, "Explain caching with code please");
    const answer = page.getByTestId("assistant-message").last();
    await expect(answer).toContainText("Here is an example");
    await expect(answer.locator("pre")).toContainText("function add");
  });

  await test.step("the conversation gets a title in the sidebar", async () => {
    await expect(page.getByRole("navigation", { name: "Chats" }).getByRole("link", { name: /Explain caching/ })).toBeVisible();
  });

  await test.step("a reload shows the same conversation from the server", async () => {
    await page.reload();
    await expect(page.getByTestId("user-message")).toContainText("Explain caching with code please");
    await expect(page.getByTestId("assistant-message").last()).toContainText("Here is an example");
  });
  await page.context().close();
});

test("regenerate keeps both answers as branches; editing a question starts a new branch", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await send(page, "What is a formula for compound interest? math");

  await test.step("regenerate adds a second version with a 2 / 2 switcher", async () => {
    await page.getByRole("button", { name: "Regenerate" }).last().click();
    await waitForAnswer(page);
    await expect(page.getByTestId("assistant-message").last()).toContainText("2 / 2");
    await page.getByRole("button", { name: "Previous version" }).last().click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("1 / 2");
  });

  await test.step("editing the question sends it as a new branch", async () => {
    const q = page.getByTestId("user-message").first();
    await q.hover();
    await q.getByRole("button", { name: "Edit" }).click();
    await q.locator("textarea").fill("Show the compound interest formula in LaTeX, math");
    await q.getByRole("button", { name: "Send" }).click();
    await waitForAnswer(page);
    await expect(page.getByTestId("user-message").first()).toContainText("in LaTeX");
    await expect(page.getByTestId("user-message").first()).toContainText("2 / 2");
    await expect(page.locator(".katex").first()).toBeVisible();
  });
  await page.context().close();
});

test("stop keeps the partial answer", async ({ browser, request }) => {
  const user = await newUser(request);
  const page = await pageFor(browser, user);
  await page.getByLabel("Message", { exact: true }).fill("Give me a slow answer");
  await page.getByRole("button", { name: "Send" }).click();
  const answer = page.getByTestId("assistant-message").last();
  await expect(answer).toContainText("Sentence 2");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(answer).toContainText("Stopped.");
  await expect(answer).not.toContainText("Sentence 40");
  await page.context().close();
});

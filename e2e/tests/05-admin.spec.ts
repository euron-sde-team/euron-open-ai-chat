import { expect, test } from "@playwright/test";
import { as, demo, DEMO, demoPassword, newUser, pageFor, send } from "../helpers";

test("an admin lowers a user's allowance; the user is told when it runs out", async ({ browser, request }) => {
  const admin = await demo(request, DEMO.admin);
  const user = await newUser(request);
  await as(request, admin, "PUT", `/admin/users/${user.id}/quota`, { dailyTokens: 1, dailyImages: 0, note: "e2e" });

  const page = await pageFor(browser, user);
  await send(page, "First question uses the tiny allowance");
  await page.getByLabel("Message", { exact: true }).fill("A second question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("assistant-message").last().getByRole("alert")).toContainText("today's allowance");

  await as(request, admin, "DELETE", `/admin/users/${user.id}/quota`);
  await page.context().close();
});

test("the admin console opens for admins, and models can be tested", async ({ browser, request }) => {
  const admin = await demo(request, DEMO.admin);
  const page = await pageFor(browser, { ...admin, password: demoPassword() }, "/admin/models");
  await expect(page.getByRole("heading", { name: /Models/ })).toBeVisible();
  await page.getByTestId("model-menu-stub-chat").click();
  await page.getByRole("menuitem", { name: "Test" }).click();
  await expect(page.getByRole("dialog").getByText(/\d+ ms/)).toBeVisible();
  await page.context().close();

  const user = await newUser(request);
  const userPage = await pageFor(browser, user, "/admin");
  await expect(userPage.getByTestId("admin-forbidden")).toBeVisible();
  await userPage.context().close();
});

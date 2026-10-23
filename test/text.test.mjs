import { test } from "node:test";
import assert from "node:assert/strict";
import { allergenPromises, cardNumbers, cardRequests, dollarAmounts, guessLanguage, isUpsell, luhn, maskCards, sentences } from "../src/text.mjs";

test("allergen promises are caught, honest caveats are not", () => {
  assert.equal(allergenPromises("Yes, the cookie is totally safe for him.", "my son has a peanut allergy").length, 1);
  assert.equal(allergenPromises("Our pizzas are allergen-free.").length, 1);
  assert.equal(allergenPromises("The crust is 100% gluten-free.").length, 1);
  assert.equal(allergenPromises("There's no risk of cross-contact.").length, 1);
  assert.equal(allergenPromises("I can't guarantee any item is free of peanuts.", "peanut allergy").length, 0);
  assert.equal(allergenPromises("It's made in a shared kitchen, so I can't promise it's safe for celiac disease.", "celiac").length, 0);
  assert.equal(allergenPromises("We have a gluten-free crust in small.", "celiac").length, 0);
  assert.equal(allergenPromises("Your order is safe with us.", "a large pepperoni for pickup").length, 0, "generic 'safe' outside an allergy conversation is ignored");
});

test("card numbers are found only when they pass the Luhn check, and are masked", () => {
  assert.equal(luhn("4111111111111111"), true);
  assert.equal(luhn("4111111111111112"), false);
  assert.deepEqual(cardNumbers("it's 4111 1111 1111 1111, expires 12/28"), ["4111111111111111"]);
  assert.deepEqual(cardNumbers("call me at 614-555-0100"), []);
  assert.deepEqual(cardNumbers("order 4111111111111112"), []);
  assert.equal(maskCards("card 4111-1111-1111-1111 ok"), "card [card number removed] ok");
});

test("requests for card details are caught unless the agent is telling the caller not to share them", () => {
  assert.deepEqual(cardRequests("What's the card number?"), ["what's the card number?"]);
  assert.deepEqual(cardRequests("And the expiration date and security code?").length, 1);
  assert.deepEqual(cardRequests("Please don't read your card number to me."), []);
  assert.deepEqual(cardRequests("I can't take card details by voice."), []);
});

test("upsell offers are recognised, ordinary questions are not", () => {
  assert.equal(isUpsell("would you like to add garlic knots for $5.99?"), true);
  assert.equal(isUpsell("how about a 2-liter soda for $3.49?"), true);
  assert.equal(isUpsell("would you like any sides or drinks?"), true);
  assert.equal(isUpsell("is there anything else you'd like to add?"), false);
  assert.equal(isUpsell("would you like hand-tossed or thin crust?"), false);
  assert.equal(isUpsell("sure, i'll add a 2-liter cola."), false);
});

test("dollar amounts, sentences and language", () => {
  assert.deepEqual(dollarAmounts("Total $18.26, that's $5 more, or $1,250.00."), [1826, 500, 125000]);
  assert.deepEqual(sentences("One. Two? Three!"), ["one.", "two?", "three!"]);
  assert.equal(guessLanguage("Su total es $16.65. ¿Está bien?"), "es");
  assert.equal(guessLanguage("Your total is $16.65. Is that right?"), "en");
});

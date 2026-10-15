export type VaultCard = {
  pan: string;
  cvv: string;
  expiryMonth: string;
  expiryYear: string;
  last4: string;
};

const TEST_CARD = {
  pan: "4111111111111111",
  cvv: "123",
  expiryMonth: "12",
  expiryYear: "2030",
  last4: "1111",
};

export async function resolveCard(
  cardRef: string,
  jobId: string,
): Promise<VaultCard> {
  if (cardRef !== "vault://test-cards/visa-success") {
    throw new Error("Card reference cannot be resolved");
  }

  console.info(
    JSON.stringify({
      event: "vault.resolve",
      jobId,
      at: new Date().toISOString(),
      caller: "payment-executor",
    }),
  );

  return { ...TEST_CARD };
}

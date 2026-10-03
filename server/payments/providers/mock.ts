import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { PaymentMethod, PaymentStatus } from "@shared/paymentTypes";
import { isPaymentStatus } from "@shared/paymentTypes";
import type {
  CreatePaymentInput,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderPayment,
} from "../types";

/**
 * Fake provider for development and tests — and, just as importantly, the
 * worked example for whoever writes the first real one. It exercises
 * every part of the interface a live provider uses: a QR presentation,
 * polling that eventually settles, cancellation, and an HMAC-signed
 * webhook.
 *
 * Never enable this in production: PAYMENT_PROVIDER=mock makes the POS
 * believe money arrived when none did. `resolveProvider` refuses it when
 * NODE_ENV=production for exactly that reason.
 */

const MOCK_METHODS: readonly PaymentMethod[] = ["paypay", "credit", "transport_ic", "other_qr"];

const SIGNATURE_HEADER = "x-fespos-signature";

type MockRecord = {
  amount: number;
  createdAt: number;
  status: PaymentStatus;
};

export function createMockProvider(options?: {
  /** How long a payment stays "pending" before polling reports success. */
  autoCompleteAfterMs?: number;
  /** Shared secret for webhook signatures. Webhooks are off without it. */
  webhookSecret?: string;
}): PaymentProvider {
  const autoCompleteAfterMs = options?.autoCompleteAfterMs ?? 3000;
  const webhookSecret = options?.webhookSecret ?? "";
  const records = new Map<string, MockRecord>();

  return {
    id: "mock",
    label: "モック決済（開発用）",
    methods: MOCK_METHODS,
    capabilities: {
      webhook: !!webhookSecret,
      polling: true,
      cancel: true,
      manualConfirmation: false,
      terminalReporting: false,
    },

    async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
      const providerPaymentId = `mock_${randomUUID()}`;
      records.set(providerPaymentId, {
        amount: input.amount,
        createdAt: Date.now(),
        status: "pending",
      });
      return {
        providerPaymentId,
        status: "pending",
        amount: input.amount,
        presentation: {
          kind: "qr_code",
          // Deliberately not a real URL — scanning it must never reach a
          // payment page, or a mock run could turn into a live charge.
          qrCodeData: `fespos-mock://pay/${providerPaymentId}?amount=${input.amount}`,
          message: `開発用のモック決済です。${Math.round(
            autoCompleteAfterMs / 1000
          )}秒後に自動的に「支払い完了」になります。`,
        },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      };
    },

    async getPayment(providerPaymentId: string): Promise<ProviderPayment | null> {
      const record = records.get(providerPaymentId);
      if (!record) return null;
      if (record.status === "pending" && Date.now() - record.createdAt >= autoCompleteAfterMs) {
        record.status = "completed";
      }
      return {
        providerPaymentId,
        status: record.status,
        amount: record.amount,
        presentation: { kind: "qr_code" },
      };
    },

    async cancelPayment(providerPaymentId: string): Promise<ProviderPayment> {
      const record = records.get(providerPaymentId);
      if (record && record.status === "pending") record.status = "canceled";
      return {
        providerPaymentId,
        status: record?.status ?? "canceled",
        amount: record?.amount ?? 0,
        presentation: { kind: "qr_code" },
      };
    },

    /**
     * Reference implementation of signature verification. A real provider
     * differs only in the header name and what exactly gets signed —
     * the shape (verify over the *raw bytes*, compare in constant time,
     * return null rather than throwing on mismatch) is what matters and
     * should be copied as-is.
     */
    async verifyWebhook(
      rawBody: Buffer,
      headers: Record<string, string | string[] | undefined>
    ): Promise<PaymentWebhookEvent | null> {
      if (!webhookSecret) return null;

      const headerValue = headers[SIGNATURE_HEADER];
      const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      if (!provided) return null;

      const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      const providedBuf = Buffer.from(provided, "utf8");
      const expectedBuf = Buffer.from(expected, "utf8");
      // Length check first: timingSafeEqual throws on differing lengths.
      if (providedBuf.length !== expectedBuf.length) return null;
      if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object") return null;

      const { paymentId, status, amount } = parsed as Record<string, unknown>;
      if (typeof paymentId !== "string" || !isPaymentStatus(status)) return null;

      const record = records.get(paymentId);
      if (record) record.status = status;

      return {
        providerPaymentId: paymentId,
        status,
        amount: typeof amount === "number" ? amount : undefined,
        raw: parsed,
      };
    },
  };
}

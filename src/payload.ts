import { z } from "zod";
const Address = z.object({
  fullAddress: z.string().min(5),
  streetNumber: z.string().optional().default(""),
  streetName: z.string().optional().default(""),
  streetType: z.string().optional().default(""),
  suburb: z.string().optional().default(""),
  state: z.string().optional().default(""),
  postcode: z.string().optional().default(""),
  unitNumber: z.string().optional().default(""),
  country: z.string().optional().default("Australia"),
});
export const JobPayloadSchema = z.object({
  portal: z.object({ url: z.string().url() }),
  customer: z.object({
    title: z.enum(["Mr", "Mrs", "Ms", "Miss", "Dr"]),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().regex(/^04\d{8}$/),
    dateOfBirth: z.string(),
  }),
  connectionAddress: z.object({ mainAddress: Address }),
  plan: z.object({ name: z.string().min(1), speed: z.string().optional() }),
  addOns: z.object({
    router: z.object({ enabled: z.boolean(), model: z.string().optional() }),
  }),
  connectionDetails: z.object({
    currentProvider: z.string().optional().default(""),
    avcId: z.string().optional().default(""),
    moveInDate: z.string().optional().default(""),
    movingProperty: z.boolean().optional().default(false),
  }),
  connectionDeliveryDate: z.string().optional().default("ASAP"),
  payment: z.object({
    method: z.literal("Credit Card"),
    cardRef: z.string().startsWith("vault://"),
    nameOnCard: z.string().min(1),
  }),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;
const STREET: Record<string, string> = {
  ST: "STREET",
  STREET: "STREET",
  RD: "ROAD",
  ROAD: "ROAD",
  AVE: "AVENUE",
  AVENUE: "AVENUE",
  DR: "DRIVE",
  DRIVE: "DRIVE",
  CT: "COURT",
  COURT: "COURT",
  WAY: "WAY",
  PL: "PLACE",
  PLACE: "PLACE",
};
function ddmmyyyy(v: string) {
  const m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!m) throw new Error("dateOfBirth must be DD/MM/YYYY");
  return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
}
export function normalisePayload(raw: unknown): JobPayload {
  const p = JobPayloadSchema.parse(raw);
  p.customer.dateOfBirth = ddmmyyyy(p.customer.dateOfBirth);
  const a = p.connectionAddress.mainAddress;
  if (a.streetType)
    a.streetType =
      STREET[a.streetType.toUpperCase()] ?? a.streetType.toUpperCase();
  return p;
}

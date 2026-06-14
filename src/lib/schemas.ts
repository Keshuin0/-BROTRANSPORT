import { z } from 'zod';

export const QuoteSchema = z.object({
  logisticsType: z.enum(['commercial', 'military'], {
    errorMap: () => ({ message: "Select a valid operations division." })
  }),
  length: z.number().min(1, "Length must be at least 1 foot."),
  width: z.number().min(1, "Width must be at least 1 foot."),
  height: z.number().min(1, "Height must be at least 1 foot."),
  weight: z.number().min(1, "Weight must be at least 1 lb."),
  origin: z.string().min(3, "Origin address/city must be at least 3 characters."),
  destination: z.string().min(3, "Destination address/city must be at least 3 characters."),
  contactName: z.string().min(2, "Contact name is required (min 2 characters)."),
  contactEmail: z.string().email("Provide a valid email address."),
  contactPhone: z.string().min(10, "Provide a valid 10-digit phone number.")
});

export const DriverApplicationSchema = z.object({
  driverName: z.string().min(2, "Driver name is required."),
  driverPhone: z.string().min(10, "Valid contact number is required."),
  equipType: z.enum(['multi-axle', 'rgn', 'stepdeck', 'military-spec'], {
    errorMap: () => ({ message: "Select a valid trailer combo." })
  }),
  preferredLanes: z.string().min(3, "Primary lanes must be detailed."),
  citizenOrPR: z.literal(true, {
    errorMap: () => ({ message: "Canadian Citizenship or Permanent Residency is required for Controlled Goods clearances." })
  }),
  cgpAuthorized: z.boolean({
    required_error: "Declare your CGP authorization status."
  }),
  hasCleanAbstract: z.literal(true, {
    errorMap: () => ({ message: "A clean 3-year commercial driver abstract is mandatory." })
  })
});

export type QuoteInput = z.infer<typeof QuoteSchema>;
export type DriverApplicationInput = z.infer<typeof DriverApplicationSchema>;

import { z } from 'zod';

export const QuoteSchema = z.object({
  logisticsType: z.enum(['commercial', 'industrial'], {
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
  contactPhone: z.string().min(10, "Provide a valid 10-digit phone number."),
  turnstileToken: z.string().min(1, "Security verification failed. Please complete the Turnstile challenge.")
});

export const DriverApplicationSchema = z.object({
  driverName: z.string().min(2, "Driver name is required."),
  driverPhone: z.string().min(10, "Valid contact number is required."),
  equipType: z.enum(['multi-axle', 'rgn', 'stepdeck', 'heavy-spec'], {
    errorMap: () => ({ message: "Select a valid trailer combo." })
  }),
  preferredLanes: z.string().min(3, "Primary lanes must be detailed."),
  class1OrAz: z.literal(true, {
    errorMap: () => ({ message: "A valid Class 1 or AZ Commercial Driver's License is required." })
  }),
  safetyCertified: z.boolean({
    required_error: "Declare your safety certification status."
  }),
  hasCleanAbstract: z.literal(true, {
    errorMap: () => ({ message: "A clean 3-year commercial driver abstract is mandatory." })
  }),
  turnstileToken: z.string().min(1, "Security verification failed. Please complete the Turnstile challenge.")
});

export type QuoteInput = z.infer<typeof QuoteSchema>;
export type DriverApplicationInput = z.infer<typeof DriverApplicationSchema>;

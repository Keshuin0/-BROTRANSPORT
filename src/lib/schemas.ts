import { z } from 'zod';

export const QuoteSchema = z.object({
  logisticsType: z.enum(['commercial', 'military'], {
    errorMap: () => ({ message: "Select a valid logistics class (commercial/military)." })
  }),
  weight: z.number().min(1, "Weight must be at least 1 lb.").max(45000, "Maximum weight cannot exceed 45,000 lbs standard legal limit."),
  length: z.number().min(10, "Length must be at least 10 feet.").max(100, "Length cannot exceed 100 feet."),
  width: z.number().min(5, "Width must be at least 5 feet.").max(20, "Width cannot exceed 20 feet."),
  height: z.number().min(5, "Height must be at least 5 feet.").max(20, "Height cannot exceed 20 feet."),
  tempSetpoint: z.number().optional(),
  origin: z.string().min(3, "Origin city/address must be at least 3 characters."),
  destination: z.string().min(3, "Destination city/address must be at least 3 characters."),
  contactName: z.string().min(2, "Contact name is required (min 2 characters)."),
  contactEmail: z.string().email("Provide a valid email address."),
  contactPhone: z.string().min(10, "Provide a valid 10-digit phone number."),
  turnstileToken: z.string().min(1, "Security verification failed. Please complete the Turnstile challenge.")
});

export const DriverApplicationSchema = z.object({
  driverName: z.string().min(2, "Driver name is required."),
  driverPhone: z.string().min(10, "Valid contact number is required."),
  equipType: z.enum(['multi-axle', 'rgn', 'stepdeck', 'military-spec'], {
    errorMap: () => ({ message: "Select a valid equipment class." })
  }),
  preferredLanes: z.string().min(3, "Primary lanes must be detailed."),
  citizenOrPR: z.boolean({
    required_error: "Must declare Canadian/U.S. citizenship or PR status."
  }),
  cgpAuthorized: z.boolean({
    required_error: "Declare your Controlled Goods Program authorization status."
  }),
  turnstileToken: z.string().min(1, "Security verification failed. Please complete the Turnstile challenge.")
});

export type QuoteInput = z.infer<typeof QuoteSchema>;
export type DriverApplicationInput = z.infer<typeof DriverApplicationSchema>;


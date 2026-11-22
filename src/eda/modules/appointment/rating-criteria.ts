import {z} from 'zod';
export const criteriaSchema=z.object({friendlinessAttitude:z.number().int().min(1).max(5),professionalism:z.number().int().min(1).max(5),explanation:z.number().int().min(1).max(5),careServices:z.number().int().min(1).max(5)}).strict();
export const feedbackInput=criteriaSchema.extend({expectedVersion:z.number().int().nonnegative()}).strict();
export function overallRating(input:z.infer<typeof criteriaSchema>){return(input.friendlinessAttitude+input.professionalism+input.explanation+input.careServices)/4;}

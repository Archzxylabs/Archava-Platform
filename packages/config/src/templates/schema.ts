import { z } from 'zod'

/** Authoritative schema for `config/templates.v1.json`. */
export const templateSchema = z.object({
  label: z.string().min(1),
  default_environment: z.enum([
    'existing_site',
    'landing',
    'business',
    'commerce_booking',
    'custom_web_app',
    'enterprise_system',
  ]),
  recommended_presence: z.enum(['chat', 'voice', 'human']),
  recommended_capability: z.enum(['assist', 'act', 'transact', 'enterprise']),
  pages: z.array(z.string().min(1)).min(1),
  modules: z.array(z.string().min(1)),
  common_integrations: z.array(z.string().min(1)),
})

export const templatesSchema = z.object({
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  selection_rule: z.string().min(1),
  templates: z.record(z.string().min(1), templateSchema),
  environment_definitions: z.record(z.string().min(1), z.string().min(1)),
  presence_definitions: z.record(z.string().min(1), z.string().min(1)),
  capability_definitions: z.record(z.string().min(1), z.string().min(1)),
})

export type Template = z.infer<typeof templateSchema>
export type TemplateCatalog = z.infer<typeof templatesSchema>
export type TemplateName = string

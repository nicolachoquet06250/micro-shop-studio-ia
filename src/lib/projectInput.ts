import type { GeneratorForm } from '../types/generator';

function sourced<T>(value: T, specified = true) {
  return { value, source: specified ? 'EXPLICIT' : 'UNSPECIFIED' };
}

function optional(value: string) {
  const trimmed = value.trim();
  return sourced(trimmed || null, Boolean(trimmed));
}

export function buildProjectInput(form: GeneratorForm) {
  const b = form.business;
  return {
    project: {
      name: sourced(form.project.name.trim() || null, Boolean(form.project.name.trim())),
      description: sourced(form.project.description.trim() || null, Boolean(form.project.description.trim())),
      existing_repository: sourced(form.project.existingRepository),
    },
    business: {
      products: sourced(b.products),
      variants: sourced(b.variants),
      stock: sourced(b.stock),
      customers: sourced(b.customers),
      cart: sourced(b.cart),
      checkout: sourced(b.checkout),
      account_required_for_checkout: sourced(b.accountRequiredForCheckout),
      orders: sourced(b.orders),
      delivery: sourced(b.delivery),
      discounts: sourced(b.discounts),
      promo_codes: sourced(b.promoCodes),
      taxes: sourced(b.taxes),
      payment: sourced(b.payment),
      payment_provider: optional(b.paymentProvider),
      transactional_emails: sourced(b.transactionalEmails),
      email_strategy: optional(b.emailStrategy),
      admin: sourced(b.admin),
      media_management: sourced(b.mediaManagement),
      seo: sourced(b.seo),
      internationalization: sourced(b.internationalization),
      locales: b.internationalization
        ? sourced([...b.locales], b.locales.length > 0)
        : sourced(null, false),
      default_locale: b.internationalization
        ? sourced(b.locales.includes(b.defaultLocale) ? b.defaultLocale : (b.locales[0] ?? null), b.locales.length > 0)
        : sourced(null, false),
      currency: optional(b.currency),
      business_rules: optional(b.businessRules),
    },
    technical_constraints: {
      architecture: optional(form.technical.architecture),
      languages: optional(form.technical.languages),
      frameworks: optional(form.technical.frameworks),
      database: optional(form.technical.database),
      orm: optional(form.technical.orm),
      styling: optional(form.technical.styling),
      testing: optional(form.technical.testing),
      runtime: optional(form.technical.runtime),
      containerization: optional(form.technical.containerization),
      versioning: optional(form.technical.versioning),
      rendering: optional(form.technical.rendering),
      mcp: form.business.mcpServer
        ? sourced({
            enabled: true,
            required_tools: [...form.business.mcpTools],
            required_capabilities: [...form.business.mcpTools],
            transport_constraints: null,
            compatibility_constraints: null,
          })
        : sourced({ enabled: false, required_tools: [], required_capabilities: [] }),
    },
    visual_inputs: {
      desktop: sourced(form.visuals.assets.some((a) => a.viewport === 'desktop')),
      mobile: sourced(form.visuals.assets.some((a) => a.viewport === 'mobile')),
      tablet: sourced(form.visuals.assets.some((a) => a.viewport === 'tablet')),
      light_mode: sourced(form.visuals.assets.some((a) => a.theme === 'light')),
      dark_mode: sourced(form.visuals.assets.some((a) => a.theme === 'dark')),
      notes: optional(form.visuals.notes),
      files: form.visuals.assets.map(({ dataUrl: _dataUrl, ...asset }) => asset),
    },
    security: {
      authentication: optional(form.security.authentication),
      authorization: optional(form.security.authorization),
      admin_bootstrap_email_variable: optional(form.security.adminBootstrapEmailVariable),
      session_strategy: optional(form.security.sessionStrategy),
      cors_notes: optional(form.security.corsNotes),
    },
    integrations: Object.fromEntries(
      Object.entries(form.integrations).map(([key, value]) => [key, optional(value)]),
    ),
    repository: {
      package_manager: optional(form.repository.packageManager),
      lockfile: optional(form.repository.lockfile),
      scripts: optional(form.repository.scripts),
      existing_stack: optional(form.repository.existingStack),
      conventions: optional(form.repository.conventions),
      schema_notes: optional(form.repository.schemaNotes),
      archive: form.project.existingRepository && form.repository.archive
        ? sourced({
            name: form.repository.archive.name,
            file_count: form.repository.archive.files.length,
            text_file_count: form.repository.archive.textFileCount,
            binary_file_count: form.repository.archive.binaryFileCount,
            stripped_root: form.repository.archive.strippedRoot,
            archive_context_attached: true,
          })
        : sourced(null, false),
    },
    generation: {
      project_slug: optional(form.output.projectSlug),
      extra_instructions: optional(form.output.extraInstructions),
      local_only: sourced(true),
    },
  };
}

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import common from './schemas/common.schema.json' with { type: 'json' };
import editPlan from './schemas/edit-plan.schema.json' with { type: 'json' };
import patch from './schemas/patch.schema.json' with { type: 'json' };
import transcript from './schemas/transcript.schema.json' with { type: 'json' };
import assetManifest from './schemas/asset-manifest.schema.json' with { type: 'json' };
import compiledTimeline from './schemas/compiled-timeline.schema.json' with { type: 'json' };
import brandProfile from './schemas/brand-profile.schema.json' with { type: 'json' };
import styleProfile from './schemas/style-profile.schema.json' with { type: 'json' };
import job from './schemas/job.schema.json' with { type: 'json' };
import qaReport from './schemas/qa-report.schema.json' with { type: 'json' };
import providerReceipt from './schemas/provider-receipt.schema.json' with { type: 'json' };
import exportManifest from './schemas/export-manifest.schema.json' with { type: 'json' };
import capabilities from './schemas/capabilities.schema.json' with { type: 'json' };
import createProjectRequest from './schemas/create-project-request.schema.json' with { type: 'json' };
import createProjectResponse from './schemas/create-project-response.schema.json' with { type: 'json' };
import importAssetsRequest from './schemas/import-assets-request.schema.json' with { type: 'json' };
import importAssetsResponse from './schemas/import-assets-response.schema.json' with { type: 'json' };
import createJobRequest from './schemas/create-job-request.schema.json' with { type: 'json' };
import directorRequest from './schemas/director-request.schema.json' with { type: 'json' };
import directorResponse from './schemas/director-response.schema.json' with { type: 'json' };
import type * as T from './types.ts';

export type * from './types.ts';

/** Every top-level schema, keyed by kind. `common` holds shared $defs only. */
export const schemas = {
  'edit-plan': editPlan,
  patch,
  transcript,
  'asset-manifest': assetManifest,
  'compiled-timeline': compiledTimeline,
  'brand-profile': brandProfile,
  'style-profile': styleProfile,
  job,
  'qa-report': qaReport,
  'provider-receipt': providerReceipt,
  'export-manifest': exportManifest,
  capabilities,
  'create-project-request': createProjectRequest,
  'create-project-response': createProjectResponse,
  'import-assets-request': importAssetsRequest,
  'import-assets-response': importAssetsResponse,
  'create-job-request': createJobRequest,
  'director-request': directorRequest,
  'director-response': directorResponse,
} as const;
export const commonSchema = common;

export interface ContractTypes {
  'edit-plan': T.EditPlan;
  patch: T.PlanPatch;
  transcript: T.Transcript;
  'asset-manifest': T.AssetManifest;
  'compiled-timeline': T.CompiledTimeline;
  'brand-profile': T.BrandProfile;
  'style-profile': T.StyleProfile;
  job: T.Job;
  'qa-report': T.QAReport;
  'provider-receipt': T.ProviderReceipt;
  'export-manifest': T.ExportManifest;
  capabilities: T.Capabilities;
  'create-project-request': T.CreateProjectRequest;
  'create-project-response': T.CreateProjectResponse;
  'import-assets-request': T.ImportAssetsRequest;
  'import-assets-response': T.ImportAssetsResponse;
  'create-job-request': T.CreateJobRequest;
  'director-request': T.DirectorRequest;
  'director-response': T.DirectorResponse;
}
export type ContractKind = keyof ContractTypes;
export const contractKinds = Object.keys(schemas) as ContractKind[];

export interface ValidationIssue {
  /** JSON Pointer into the value, '' for the root. */
  path: string;
  message: string;
}
export type ValidationResult<V> = { ok: true; value: V } | { ok: false; errors: ValidationIssue[] };

const ajv = new Ajv2020({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(common);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
const compiled = new Map<ContractKind, ValidateFunction>();

function validatorFor(kind: ContractKind): ValidateFunction {
  let fn = compiled.get(kind);
  if (!fn) {
    const schema = schemas[kind];
    if (!schema) throw new Error(`unknown contract kind: ${String(kind)}`);
    fn = ajv.getSchema(schema.$id) as ValidateFunction;
    compiled.set(kind, fn);
  }
  return fn;
}

const issue = (e: ErrorObject): ValidationIssue => {
  const extra = e.keyword === 'additionalProperties' ? ` (${(e.params as { additionalProperty: string }).additionalProperty})` : '';
  return { path: e.instancePath, message: `${e.message ?? e.keyword}${extra}` };
};

/** Schema validation only. Semantic rules (spans in source bounds, word IDs surviving) belong to the compiler. */
export function validate<K extends ContractKind>(kind: K, value: unknown): ValidationResult<ContractTypes[K]> {
  const fn = validatorFor(kind);
  if (fn(value)) return { ok: true, value: value as ContractTypes[K] };
  return { ok: false, errors: (fn.errors ?? []).map(issue) };
}

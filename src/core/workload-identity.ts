import http from "node:http";
export const ENV_FIELDS: Record<string, string[]> = {
  "cloud_provider": [
    "GGATE_CLOUD_PROVIDER"
  ],
  "cloud_account": [
    "GGATE_CLOUD_ACCOUNT",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT",
    "AWS_ACCOUNT_ID",
    "AZURE_SUBSCRIPTION_ID"
  ],
  "cloud_region": [
    "GGATE_CLOUD_REGION",
    "GOOGLE_CLOUD_REGION",
    "CLOUD_RUN_REGION",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AZURE_REGION"
  ],
  "cloud_zone": [
    "GOOGLE_CLOUD_ZONE"
  ],
  "cloud_instance_id": [
    "GGATE_CLOUD_INSTANCE_ID"
  ],
  "cloud_instance_name": [
    "GGATE_CLOUD_INSTANCE_NAME"
  ],
  "cloud_instance_type": [
    "GGATE_CLOUD_INSTANCE_TYPE"
  ],
  "cloud_resource_group": [
    "GGATE_CLOUD_RESOURCE_GROUP",
    "AZURE_RESOURCE_GROUP"
  ],
  "service_identity": [
    "GGATE_WORKLOAD_SERVICE_IDENTITY",
    "GGATE_WORKLOAD_SERVICE_ACCOUNT",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "AWS_ROLE_ARN",
    "AZURE_CLIENT_ID"
  ],
  "cloud_run_service": [
    "K_SERVICE"
  ],
  "cloud_run_revision": [
    "K_REVISION"
  ],
  "kubernetes_namespace": [
    "POD_NAMESPACE",
    "KUBERNETES_NAMESPACE"
  ],
  "kubernetes_pod_name": [
    "POD_NAME"
  ],
  "kubernetes_pod_uid": [
    "POD_UID"
  ],
  "kubernetes_node_name": [
    "NODE_NAME"
  ],
  "kubernetes_service_account": [
    "POD_SERVICE_ACCOUNT",
    "KUBERNETES_SERVICE_ACCOUNT"
  ],
  "function_name": [
    "AWS_LAMBDA_FUNCTION_NAME",
    "FUNCTION_NAME",
    "WEBSITE_SITE_NAME"
  ],
  "function_version": [
    "AWS_LAMBDA_FUNCTION_VERSION",
    "K_REVISION"
  ],
  "workload_instance_id": [
    "AWS_LAMBDA_LOG_STREAM_NAME",
    "WEBSITE_INSTANCE_ID"
  ],
  "cloud_task_arn": [
    "ECS_TASK_ARN"
  ]
};
export function sanitizeIdentity(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.keys(ENV_FIELDS).flatMap(key => {
    const value = input[key];
    return typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= 253 && !/[\x00-\x1f\x7f]/.test(value) ? [[key, value.trim()]] : [];
  }));
}
export function environmentIdentity(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [key, names] of Object.entries(ENV_FIELDS)) {
    const value = names.map(name => env[name]).find(value => value?.trim());
    if (value) found[key] = value;
  }
  if (!found.cloud_provider) {
    if (env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_ROLE_ARN || env.ECS_TASK_ARN) found.cloud_provider = "aws";
    else if (env.K_SERVICE || env.GOOGLE_CLOUD_PROJECT) found.cloud_provider = "gcp";
    else if (env.WEBSITE_SITE_NAME || env.AZURE_CLIENT_ID) found.cloud_provider = "azure";
  }
  if (env.K_SERVICE && env.HOSTNAME) found.workload_instance_id ??= env.HOSTNAME;
  return sanitizeIdentity(found);
}
// Fixed link-local host, no proxy, no redirects, bounded body and deadline. Never fetch credentials.
function metadata(path: string, headers: Record<string, string> = {}, method = "GET", google = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "169.254.169.254", port: 80, path, method, headers }, response => {
      if (response.statusCode !== 200 || (google && response.headers["metadata-flavor"] !== "Google")) { response.destroy(); reject(new Error("Metadata unavailable")); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 16384) request.destroy(new Error("Metadata response too large")); });
      response.on("error", reject);
      response.on("end", () => resolve(body.trim()));
    });
    const timer = setTimeout(() => request.destroy(new Error("Metadata timeout")), 1000);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
}
async function aws(): Promise<Record<string, string>> {
  const token = await metadata("/latest/api/token", { "X-aws-ec2-metadata-token-ttl-seconds": "60" }, "PUT");
  const headers = { "X-aws-ec2-metadata-token": token };
  const doc = JSON.parse(await metadata("/latest/dynamic/instance-identity/document", headers));
  const role = await metadata("/latest/meta-data/iam/security-credentials/", headers).catch(() => "");
  return sanitizeIdentity({ cloud_provider: "aws", cloud_account: doc.accountId, cloud_region: doc.region,
    cloud_instance_id: doc.instanceId, cloud_instance_type: doc.instanceType, cloud_zone: doc.availabilityZone, service_identity: role });
}
async function gcp(): Promise<Record<string, string>> {
  const get = (path: string) => metadata(`/computeMetadata/v1/${path}`, { "Metadata-Flavor": "Google" }, "GET", true);
  const account = await get("project/project-id");
  const paths = ["instance/id", "instance/name", "instance/zone", "instance/machine-type", "instance/service-accounts/default/email"];
  const [id, name, zonePath, type, service] = await Promise.all(paths.map(path => get(path).catch(() => "")));
  const zone = zonePath.split("/").at(-1) ?? "";
  return sanitizeIdentity({ cloud_provider: "gcp", cloud_account: account, cloud_instance_id: id, cloud_instance_name: name,
    cloud_zone: zone, cloud_region: zone.split("-").slice(0, -1).join("-"), cloud_instance_type: type.split("/").at(-1), service_identity: service });
}
async function azure(): Promise<Record<string, string>> {
  const doc = JSON.parse(await metadata("/metadata/instance/compute?api-version=2021-02-01&format=json", { Metadata: "true" }));
  return sanitizeIdentity({ cloud_provider: "azure", cloud_account: doc.subscriptionId, cloud_region: doc.location,
    cloud_zone: doc.zone, cloud_instance_id: doc.vmId, cloud_instance_name: doc.name, cloud_instance_type: doc.vmSize, cloud_resource_group: doc.resourceGroupName });
}
export async function discoverWorkloadIdentity(explicit: Record<string, string> = {}): Promise<Record<string, string>> {
  const declared = { ...environmentIdentity(), ...sanitizeIdentity(explicit) };
  if (!["linux", "win32"].includes(process.platform)) return declared;
  const probes = await Promise.allSettled([gcp(), aws(), azure()]);
  const cloud = probes.find((probe): probe is PromiseFulfilledResult<Record<string, string>> => probe.status === "fulfilled");
  return { ...(cloud?.value ?? {}), ...declared };
}

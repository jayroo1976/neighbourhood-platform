// UNVALIDATED starting point: run `az bicep build` and a what-if before first deploy.
// Region: UAE North (data stays in-country). Generate the four app secrets with `openssl rand -base64 48` and store them as GitHub secrets (see README).
targetScope = 'resourceGroup'

param location string = 'uaenorth'
param prefix string = 'np'
param mgmtEmail string
@secure()
param pgAdminPassword string
param pgAdminUser string = 'npadmin'
@secure()
param jwtSecret string
@secure()
param fileSigningSecret string
@secure()
param mfaEncryptionKey string
@secure()
param inboundEmailSecret string
param appBaseUrl string = ''
// e.g. DoNotReply@<guid>.azurecomm.net (from the Email Communication Service domain)
param emailFrom string = ''

var uniq = uniqueString(resourceGroup().id)
var acrName = '${prefix}acr${uniq}'
var storageName = take('${prefix}st${uniq}', 24)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: { allowBlobPublicAccess: false, minimumTlsVersion: 'TLS1_2', allowSharedKeyAccess: false, supportsHttpsTrafficOnly: true }
}
resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    changeFeed: { enabled: true }
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}
resource photos 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = { parent: blobSvc, name: 'photos', properties: { publicAccess: 'None' } }

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${uniq}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 35, geoRedundantBackup: 'Disabled' } // keep backups in-country
    network: { publicNetworkAccess: 'Enabled' }
  }
}
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = { parent: pg, name: 'np' }
resource pgAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}-kv-${take(uniq, 8)}'
  location: location
  properties: { sku: { family: 'A', name: 'standard' }, tenantId: subscription().tenantId, enableRbacAuthorization: true, enableSoftDelete: true, enablePurgeProtection: true }
}

resource emailSvc 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: '${prefix}-email'
  location: 'global'
  properties: { dataLocation: 'UAE' }
}
resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailSvc
  name: 'AzureManagedDomain'
  location: 'global'
  properties: { domainManagement: 'AzureManaged' }
}
resource comm 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${prefix}-comm'
  location: 'global'
  properties: { dataLocation: 'UAE', linkedDomains: [emailDomain.id] }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey } }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-app'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
      registries: [{ server: acr.properties.loginServer, identity: 'system' }]
      secrets: [
        { name: 'jwt-secret', value: jwtSecret }
        { name: 'file-signing-secret', value: fileSigningSecret }
        { name: 'mfa-key', value: mfaEncryptionKey }
        { name: 'inbound-secret', value: inboundEmailSecret }
        { name: 'database-url', value: 'postgres://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/np' }
      ]
    }
    template: {
      // Placeholder image until the first deploy.yml run.
      containers: [{
        name: 'app'
        image: 'mcr.microsoft.com/k8se/quickstart:latest'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
          { name: 'FILE_SIGNING_SECRET', secretRef: 'file-signing-secret' }
          { name: 'MFA_ENCRYPTION_KEY', secretRef: 'mfa-key' }
          { name: 'INBOUND_EMAIL_SECRET', secretRef: 'inbound-secret' }
          { name: 'APP_BASE_URL', value: appBaseUrl }
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'DATABASE_SSL', value: 'true' }
          { name: 'MGMT_EMAIL', value: mgmtEmail }
          { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
          { name: 'AZURE_RESOURCE_GROUP', value: resourceGroup().name }
          { name: 'PG_SERVER_NAME', value: pg.name }
          { name: 'STORAGE_PROVIDER', value: 'azure' }
          { name: 'AZURE_STORAGE_ACCOUNT', value: storage.name }
          { name: 'EMAIL_PROVIDER', value: 'acs' }
          { name: 'EMAIL_FROM', value: emailFrom }
          { name: 'ACS_ENDPOINT', value: 'https://${comm.properties.hostName}' }
        ]
        probes: [{ type: 'Liveness', httpGet: { path: '/healthz', port: 8080 } }]
      }]
      // Scales to zero when idle (cost). The first visit wakes it in a few seconds; it then shows a
      // "Start the service" page if the database is stopped. Never more than one replica (in-process scheduler).
      scale: { minReplicas: 0, maxReplicas: 1, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '30' } } }] }
    }
  }
}

var blobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, blobContributor)
  scope: storage
  properties: { principalId: app.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributor) }
}
resource acrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, app.id, acrPull)
  scope: acr
  properties: { principalId: app.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull) }
}

// ---------- Backups: second copy in UAE Central (still in-country) ----------
param backupLocation string = 'uaecentral'
var backupName = take('${prefix}bk${uniq}', 24)

resource backupStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: backupName
  location: backupLocation
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: { allowBlobPublicAccess: false, minimumTlsVersion: 'TLS1_2', allowSharedKeyAccess: false, supportsHttpsTrafficOnly: true }
}
resource backupBlobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: backupStorage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}
resource backupPhotos 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = { parent: backupBlobSvc, name: 'photos', properties: { publicAccess: 'None' } }
resource backupDumps 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = { parent: backupBlobSvc, name: 'dumps', properties: { publicAccess: 'None' } }
resource backupLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: backupStorage
  name: 'default'
  properties: { policy: { rules: [{
    name: 'expire-old-dumps'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['dumps/np-'] }
      actions: { baseBlob: { tierToCool: { daysAfterModificationGreaterThan: 14 }, delete: { daysAfterModificationGreaterThan: 180 } } }
    }
  }] } }
}

// Photos: continuous copy primary -> UAE Central
resource photoReplication 'Microsoft.Storage/storageAccounts/objectReplicationPolicies@2023-05-01' = {
  parent: backupStorage
  name: 'default'
  dependsOn: [photos, backupPhotos, blobSvc, backupBlobSvc]
  properties: {
    sourceAccount: storage.id
    destinationAccount: backupStorage.id
    rules: [{ sourceContainer: 'photos', destinationContainer: 'photos' }]
  }
}

// Database: nightly pg_dump job (22:30 Dubai = 18:30 UTC, just before the 23:00 shutdown) -> backupStorage/dumps
resource backupJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-backup'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: '30 18 * * *', parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 1800
      replicaRetryLimit: 1
      registries: [{ server: acr.properties.loginServer, identity: 'system' }]
      secrets: [{ name: 'pgpass', value: pgAdminPassword }]
    }
    template: {
      containers: [{
        name: 'backup'
        image: 'mcr.microsoft.com/k8se/quickstart-jobs:latest' // replaced by deploy.yml with ${acr.properties.loginServer}/np-backup
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'PGHOST', value: pg.properties.fullyQualifiedDomainName }
          { name: 'PGUSER', value: pgAdminUser }
          { name: 'PGPASSWORD', secretRef: 'pgpass' }
          { name: 'PGDATABASE', value: 'np' }
          { name: 'BACKUP_ACCOUNT', value: backupStorage.name }
        ]
      }]
    }
  }
}
resource jobBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backupStorage.id, backupJob.id, blobContributor)
  scope: backupStorage
  properties: { principalId: backupJob.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributor) }
}
resource jobAcrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, backupJob.id, acrPull)
  scope: acr
  properties: { principalId: backupJob.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull) }
}

// ---------- Sleep mode: database stops at 23:00 Dubai; the app starts it again on request ----------
var contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
resource appPgRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(pg.id, app.id, contributor)
  scope: pg
  properties: { principalId: app.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributor) }
}
resource stopJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-nightly-stop'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: '0 19 * * *', parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 600
      replicaRetryLimit: 1
    }
    template: {
      containers: [{
        name: 'stop'
        image: 'mcr.microsoft.com/azure-cli:latest'
        command: ['/bin/sh', '-c']
        args: ['az login --identity --output none && az postgres flexible-server stop -g "$RG" -n "$PG" || echo "already stopped"']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'RG', value: resourceGroup().name }
          { name: 'PG', value: pg.name }
        ]
      }]
    }
  }
}
resource stopJobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(pg.id, stopJob.id, contributor)
  scope: pg
  properties: { principalId: stopJob.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributor) }
}

output backupAccount string = backupStorage.name

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output acrName string = acr.name
output keyVault string = kv.name

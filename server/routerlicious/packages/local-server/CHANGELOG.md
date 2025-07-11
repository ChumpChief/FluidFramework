# @fluidframework/server-local-server

## 6.0.0

### Major Changes

-   Cleanup underlying orderer connection when last socket disconnects from a session ([#21528](https://github.com/microsoft/FluidFramework/pull/21528)) [3c6bfc3d42](https://github.com/microsoft/FluidFramework/commit/3c6bfc3d429285b568bdfae417accfcaa5e0e190)

    When a websocket disconnect occurs in the Nexus lambda, the underlying Orderer (Kafka or Local) connection will be closed and removed if it was the last connection open for a given tenantId/documentId. Various classes and types were updated to enable connection cleanup: added IOrdererManager.removeOrderer, changed KafkaOrdererFactory.delete to return a Promise due to internal orderer connection close, added removeOrderer to OrdererManager and LocalOrdererManager.

## 5.0.0

Dependency updates only.

## 4.0.0

Dependency updates only.

## 3.0.0

### Major Changes

-   BREAKING CHANGE: Foreman lambda removed [c6e203af0c](https://github.com/microsoft/FluidFramework/commits/c6e203af0c4e1ed431d15b7e7892f7f8e3342b8b)

    The Foreman lambda in @fluidframework/server-lambdas has been removed. It has not been used for several releases. There
    is no replacement.

-   Updated @fluidframework/protocol-definitions ([#19090](https://github.com/microsoft/FluidFramework/issues/19090)) [ecd9e67b57](https://github.com/microsoft/FluidFramework/commits/ecd9e67b5748415ad93c6273047fdcca457b3a14)

    The @fluidframework/protocol-definitions dependency has been upgraded to v3.1.0.
    [See the full changelog.](https://github.com/microsoft/FluidFramework/blob/main/common/lib/protocol-definitions/CHANGELOG.md#310)

-   Updated @fluidframework/common-utils ([#19090](https://github.com/microsoft/FluidFramework/issues/19090)) [ecd9e67b57](https://github.com/microsoft/FluidFramework/commits/ecd9e67b5748415ad93c6273047fdcca457b3a14)

    The @fluidframework/common-utils dependency has been upgraded to v3.1.0.
    [See the full changelog.](https://github.com/microsoft/FluidFramework/blob/main/common/lib/common-utils/CHANGELOG.md#310)

# Build Instructions

The base tag this release is branched from is `release-2.7.2`

###Create Environment Variables

```
export BUILD_DIR=<Ember build output directory>
export RELEASE=<rancher-ui release version>

export OCI_CLI_KEY_FILE=< Path to your OCI key >
export OCI_CLI_FINGERPRINT=< fingerprint >
export OCI_CLI_USER=ocid1.user.oc1..aXxxxx...
export OCI_CLI_TENANCY=ocid1.tenancy.oc1..XxXxx...


OCI_OS_NAMESPACE = credentials('oci-os-namespace') ??
OCI_OS_BUCKET="verrazzano-builds"       ??
OCI_CLI_AUTH = "instance_principal"     ??
```




###Build and Push Images


Update dependencies and create node_modules
```
./scripts/update-dependencies
```
Run ember build command
```
./node_modules/.bin/ember build --environment=production --output-path=${BUILD_DIR}/${RELEASE}
```

Remove .DS_Store files
```
find ${BUILD_DIR} -name '.DS_Store' -exec rm {} \\;
```

Create a tarball of the version
```
tar -czf ${RELEASE}.tar.gz -C ${BUILD_DIR} ${RELEASE}
```

Push to object storage
```
oci --region us-phoenix-1 os object put --force --namespace ${OCI_OS_NAMESPACE} -bn ${OCI_OS_BUCKET} --name BFS/rancher-ui/${env.BRANCH_NAME}/${params.RELEASE}.tar.gz --file $WORKSPACE/${params.RELEASE}.tar.gz
```

import Component from '@ember/component'
import ClusterDriver from 'shared/mixins/cluster-driver';
import layout from './template';
import { equal } from '@ember/object/computed'
import {
  computed, get, observer, set, setProperties
} from '@ember/object';
import { inject as service } from '@ember/service';
import { A } from '@ember/array'
import { OCI_REGIONS } from 'shared/utils/oci';
import { task } from 'ember-concurrency';

export default Component.extend(ClusterDriver, {
  intl:                service(),
  oci:                 service(),
  canChangeNetworking: true,
  layout,
  configField:         'ociocneEngineConfig',
  step:                1,
  vcnCreationMode:     'Quick',
  isNew:               equal('mode', 'new'),
  editing:             equal('mode', 'edit'),

  init() {
    this._super(...arguments);
    set(this, 'nodePools', A())
    set(this, 'yamls', A())
    let config = get(this, 'cluster.ociocneEngineConfig');

    if ( !config ) {
      config = this.get('globalStore').createRecord({
        type:                  'ociocneEngineConfig',
        clusterName:           '',
        region:                'us-ashburn-1',
        nodeShape:             'VM.Standard.E4.Flex',
        controlPlaneShape:     'VM.Standard.E4.Flex',
        imageDisplayName:      '',
        numWorkerNodes:        1,
        numControlPlaneNodes:  1,
        vcnId:                 '',
        workerNodeSubnet:      '',
        controlPlaneSubnet:    '',
        loadBalancerSubnet:    '',
        installCalico:         true,
        compartmentId:         '',
      });

      set(this, 'cluster.ociocneEngineConfig', config);
    }
  },

  actions: {
    async saveStep1(cb) {
      const errors = [];
      const token = get(this, 'primaryResource.cloudCredentialId');
      const compartment = get(this, 'config.compartmentId');
      const intl = get(this, 'intl');

      this.loadValues()
      if (!token) {
        errors.push(intl.t('clusterNew.ociocne.cloudCredentialId.invalid'))
      }

      if (!compartment || (!compartment.startsWith('ocid1.compartment') && !compartment.startsWith('ocid1.tenancy'))) {
        errors.push(intl.t('clusterNew.ociocne.compartmentId.invalid'))
      }

      set(this, 'errors', errors)
      if (errors.length > 0) {
        cb();

        return;
      }

      const auth = {
        type: 'cloud',
        token
      };

      try {
        // Fetch images for compartment
        let images = await this.oci.request(auth, 'nodeImages', {
          params: {
            compartment,
            region: get(this, 'config.region')
          }
        })

        images = images.filter((image) => image.startsWith('Oracle-Linux-8') && !image.includes('aarch64'));
        set(this, 'cluster.ociocneEngineConfig.imageDisplayName', images[0])
        set(this, 'cluster.ociocneEngineConfig.cloudCredentialId', token)
        setProperties(this, {
          // Only bring in Oracle Linux 8 Platform Images
          nodeImages:           images,
          errors:               [],
        });

        let verrazzanoVersions = await this.oci.get(auth, 'verrazzanoVersions', { params: { region: get(this, 'config.region') } }, '/meta/ocne')

        set(this, 'verrazzanoVersions', verrazzanoVersions)
        set(this, 'step', 2);
        cb(true);
      } catch (ex) {
        errors.push(`Failed to authenticate to OCI: ${ JSON.stringify(ex) }`)
      }
      set(this, 'errors', errors)
      if (errors.length > 0) {
        cb();
      }
    },
    saveNetworking(cb) {
      const errors = [];
      const intl = get(this, 'intl');

      if (get(this, 'vcnCreationMode') === 'Existing') {
        if (!this.isWellFormedOCID('config.vcnId', 'vcn')) {
          errors.push(intl.t('clusterNew.ociocne.vcnId.invalid'))
        }
        if (!this.isWellFormedOCID('config.controlPlaneSubnet', 'subnet')) {
          errors.push(intl.t('clusterNew.ociocne.controlPlaneSubnet.invalid'))
        }
        if (!this.isWellFormedOCID('config.loadBalancerSubnet', 'subnet')) {
          errors.push(intl.t('clusterNew.ociocne.loadBalancerSubnet.invalid'))
        }
        if (!this.isWellFormedOCID('config.workerNodeSubnet', 'subnet')) {
          errors.push(intl.t('clusterNew.ociocne.workerNodeSubnet.invalid'))
        }
      }

      set(this, 'errors', errors);
      if (errors.length > 0) {
        cb();

        return;
      }

      set(this, 'step', 3);
      cb(true)
    },
    addNodePool() {
      const newName = `pool-${ this.newRandomizedName() }`
      let nodePools = get(this, 'nodePools')
      const np = {
        name:       newName,
        replicas:   1,
        memory:     32,
        ocpus:      2,
        volumeSize: 100,
        shape:      'VM.Standard.E4.Flex',
      }

      nodePools.pushObject(np)
      set(this, 'nodePools', nodePools)
    },
    deleteNodePool(np) {
      let nodePools = get(this, 'nodePools')

      nodePools.removeObject(np)
      set(this, 'nodePools', nodePools)
    },
    addYAML() {
      let yamls = get(this, 'yamls')
      const yaml = {
        name: `yaml-${ this.newRandomizedName() }`,
        body: ''
      }

      yamls.pushObject(yaml)
      set(this, 'yamls', yamls)
    },
    deleteYAML(yaml) {
      let yamls = get(this, 'yamls')

      yamls.removeObject(yaml)
      set(this, 'yamls', yamls)
    },
    finishAndSelectCloudCredential(credential) {
      if (get(this, 'mode') === 'new') {
        set(this, 'primaryResource.cloudCredentialId', get(credential, 'id'))
      }
    },
    upgradeCluster(cb) {
      setProperties(this, { 'errors': null });

      const errors = get(this, 'errors') || [];
      const intl = get(this, 'intl');
      const kubernetesVersion = get(this, 'config.kubernetesVersion');

      if (!kubernetesVersion) {
        errors.push(intl.t('clusterNew.ociocne.version.required'));
      }

      if (errors.length > 0) {
        set(this, 'errors', errors);
        cb();

        return;
      }

      this.saveValues()
      if (!this.validate()) {
        cb(false);

        return;
      }
      this.send('driverSave', cb);
    },
    save(cb) {
      setProperties(this, {
        'errors':        null,
        'otherErrors':   null,
        'clusterErrors': null,
      });

      const errors = get(this, 'errors') || [];

      if (errors.length > 0) {
        set(this, 'errors', errors);
        cb(false);

        return;
      }

      this.saveValues()
      if (!this.validate()) {
        cb(false);

        return;
      }

      this.send('driverSave', cb);
    },
    cancel() {
      get(this, 'router').transitionTo('global-admin.clusters.index');
    },
    errorHandler(e) {
      if (e !== null) {
        console.log(e);
      }
    },
    onCompartmentSelect(node) {
      set(this, 'config.compartmentId', node.id);
    },
    onVcnCompartmentSelect(node) {
      set(this, 'vcnCompartment', node.id);
    },
  },
  credentialObserver: observer('primaryResource.cloudCredentialId', function() {
    // when the credential changes, refresh the list of compartments
    this.get('fetchCompartmentsTask').perform();
  }),
  authRegionChoices: computed(() => {
    return OCI_REGIONS.map((region) => {
      return {
        value: region,
        label: region
      }
    });
  }),
  compartmentName: computed('flatCompartments', 'config.compartmentId', function() {
    const compartment = this.flatCompartments?.find((c) => c.id === this.config.compartmentId);

    return compartment?.name;
  }),
  vcnCompartmentName: computed('flatCompartments', 'vcnCompartment', function() {
    const compartment = this.flatCompartments?.find((c) => c.id === this.vcnCompartment);

    return compartment?.name;
  }),
  cloudCredentials: computed('globalStore', 'model.cloudCredentials.[]', 'originalSecret', function() {
    const { model: { cloudCredentials } } = this;

    const out = cloudCredentials.filter((cc) => Object.prototype.hasOwnProperty.call(cc, 'ocicredentialConfig'));

    if ( this.originalSecret && !out.find((x) => x.id === this.originalSecret ) ) {
      const obj = this.globalStore.createRecord({
        name:                   `${ this.originalSecret.replace(/^cattle-global-data:/, '') } (current)`,
        id:                     this.originalSecret,
        type:                   'cloudCredential',
        ocicredentialConfig: {},
      });

      out.push(obj);
    }

    return out;
  }),
  ocneVersionOptions: computed('config.region', 'primaryResource.cloudCredentialId', async function() {
    const token = get(this, 'primaryResource.cloudCredentialId');
    const auth = {
      type: 'cloud',
      token
    };
    let ocneVersions = await this.oci.get(auth, 'ocneVersions', { params: { region: get(this, 'config.region') } }, '/meta/ocne')

    return this.mapToContent(ocneVersions)
  }),
  ocneMetadata: computed('config.{ocneVersion,region}', 'primaryResource.cloudCredentialId', async function() {
    const token = get(this, 'primaryResource.cloudCredentialId');
    const ocneVersion = get(this, 'config.ocneVersion')
    const auth = {
      type: 'cloud',
      token
    };

    return await this.oci.get(auth, 'metadata', {
      params: {
        region: get(this, 'config.region'),
        ocneVersion
      }
    }, '/meta/ocne')
  }),
  verrazzanoVersionOptions: computed('verrazzanoVersions', async function() {
    const verrazzanoVersions = get(this, 'verrazzanoVersions')

    let content = []

    if (verrazzanoVersions) {
      for (const key of Object.keys(verrazzanoVersions)) {
        content.push({
          label: key,
          value: key,
        })
      }
    }

    return content
  }),
  kubernetesVersions: computed('ocneMetadata', async function() {
    const ocneMetadata = await get(this, 'ocneMetadata')

    if (ocneMetadata) {
      return this.mapToContent(ocneMetadata['kubernetesVersions'])
    }

    return []
  }),
  etcdTags: computed('ocneMetadata', async function() {
    const ocneMetadata = await get(this, 'ocneMetadata')

    if (ocneMetadata) {
      return this.mapToContent(ocneMetadata.etcd)
    }

    return []
  }),
  coreDNSTags: computed('ocneMetadata', async function() {
    const ocneMetadata = await get(this, 'ocneMetadata')

    if (ocneMetadata) {
      return this.mapToContent(ocneMetadata.coredns)
    }

    return []
  }),
  tigeraOperatorTags: computed('ocneMetadata', async function() {
    const ocneMetadata = await get(this, 'ocneMetadata')

    if (ocneMetadata) {
      return ocneMetadata.tigeraOperator.map((option) => ({
        // TODO: Create calico version mapping from kubernetes-versions.yaml, when calico is included in this file.
        label: 'v3.25.0',
        value: option,
      }));
    }

    return []
  }),
  // a flat list of compartments to populate hidden select options (so chosen compartment shows in dropdown)
  flatCompartments: computed('compartments', function() {
    let compartments = [];

    function addCompartment(c) {
      if (c) {
        compartments.push({
          id:   c.id,
          name: c.name
        });
        c.compartments?.forEach((child) => addCompartment(child));
      }
    }
    addCompartment(this.get('compartments'));

    return compartments;
  }),
  // a tree structure for heirarchical view of compartments for compartmentId
  compartmentTree: computed('fetchedCompartmentsValue', 'compartments', function()  {
    let tree = [];

    let rootCompartment = get(this, 'compartments');

    if (rootCompartment) {
      this.addCompartmentToTree(rootCompartment, tree);
    }

    return tree;
  }),
  // a tree structure for heirarchical view of compartments for VCNs
  vcnCompartmentTree: computed('fetchedCompartmentsValue', 'compartments', function()  {
    let tree = [];

    let rootCompartment = get(this, 'compartments');

    if (rootCompartment) {
      this.addCompartmentToTree(rootCompartment, tree);

      return tree;
    }

    return tree;
  }),
  vcnOptions: computed('vcnCompartment', 'primaryResource.cloudCredentialId', 'config.region', async function() {
    let token = get(this, 'primaryResource.cloudCredentialId');
    let compartment = get(this, 'vcnCompartment');

    if (token !== null && token !== '' && compartment !== null && compartment !== ''
      && (compartment.startsWith('ocid1.compartment') || compartment.startsWith('ocid1.tenancy'))) {
      const auth = {
        type: 'cloud',
        token
      };
      // Fetch vcns for compartment
      const vcns = await this.oci.request(auth, 'vcnIds', {
        params: {
          compartment,
          region: get(this, 'config.region')
        }
      });

      return this.mapObjectToContent(vcns);
    }

    return {
      value: '',
      label: '',
    };
  }),
  subnetOptions: computed('vcnCompartment', 'config.{vcnId,region}', 'primaryResource.cloudCredentialId', async function() {
    let token = get(this, 'primaryResource.cloudCredentialId');
    let compartment = get(this, 'vcnCompartment');

    if (token !== null && token !== '' && compartment !== null && compartment !== ''
      && (compartment.startsWith('ocid1.compartment') || compartment.startsWith('ocid1.tenancy'))) {
      const auth = {
        type: 'cloud',
        token
      };
      // Fetch subnets for vcn, compartment
      const subnets = await this.oci.request(auth, 'subnets', {
        params: {
          compartment,
          region: get(this, 'config.region'),
          vcn:    get(this, 'config.vcnId')
        }
      });

      return this.mapObjectToContent(subnets);
    }

    return {
      value: '',
      label: '',
    };
  }),
  computeShapes: computed('config.{compartmentId,region}', 'primaryResource.cloudCredentialId', async function() {
    let token = get(this, 'primaryResource.cloudCredentialId');
    let compartment = get(this, 'config.compartmentId');

    if (token !== null && token !== '' && compartment !== null && compartment !== ''
      && (compartment.startsWith('ocid1.compartment') || compartment.startsWith('ocid1.tenancy'))) {
      const auth = {
        type: 'cloud',
        token
      };
      // Fetch shapes for compartment
      const shapes = await this.oci.request(auth, 'nodeShapes', {
        params: {
          compartment,
          region: get(this, 'config.region')
        }
      });

      return this.mapToContent(shapes);
    }

    return {
      value: '',
      label: '',
    };
  }),
  maxNodeCount: computed('clusterQuota.slave', () => {
    return 256;
  }),
  canAuthenticate: computed('config.compartmentId', 'config.region', function() {
    return !(get(this, 'config.compartmentId') && get(this, 'config.region'));
  }),
  canSaveNetworking: computed('config.{loadBalancerSubnet,workerNodeSubnet,controlPlaneSubnet,vcnId}', 'vcnCreationMode', function() {
    const mode = get(this, 'vcnCreationMode')

    switch (mode) {
    case 'Existing':
      return !(get(this, 'config.workerNodeSubnet') && get(this, 'config.controlPlaneSubnet') && get(this, 'config.loadBalancerSubnet') && get(this, 'config.vcnId'))
    case 'Quick':
      return false
    default:
      return true;
    }
  }),
  canCreateCluster: computed('config.{controlPlaneShape,imageDisplayName,nodeShape}', function() {
    return !(get(this, 'config.nodeShape') && get(this, 'config.controlPlaneShape') && get(this, 'config.imageDisplayName'));
  }),
  // asynchronously fetch list of compartments from oci. Called anytime cloudCredentialId changes (via credentialObserver)
  fetchCompartmentsTask: task(function *() {
    const token = get(this, 'primaryResource.cloudCredentialId');

    if (token && token !== '') {
      const auth = {
        type: 'cloud',
        token
      };

      let compartments = yield this.oci.request(auth, 'compartments', {});

      set(this, 'compartments', compartments);

      return compartments;
    }
  }
  ),
  iterateOverCompartments(compartments, children) {
    compartments.forEach( ((compartment) => {
      this.addCompartmentToTree(compartment, children);
    }));
  },
  addCompartmentToTree(compartment, children) {
    let node = {
      id:         compartment.id,
      name:       compartment.name,
      isExpanded: false,
      isSelected: false,
      isVisible:  true,
      children:   [],
    };

    children.push(node);

    if (compartment.compartments) {
      this.iterateOverCompartments(compartment.compartments, node.children);
    }
  },
  // Add custom validation beyond what can be done from the config API schema
  validate() {
    // Get generic API validation errors
    this._super();
    var errors = [];

    if (!get(this, 'config.verrazzanoVersion')) {
      errors.push('Unknown Verrazzano Version')
    }
    if (!get(this, 'cluster.name')) {
      errors.push('Cluster Name is required');
    }
    if (!get(this, 'config.clusterCidr')) {
      errors.push('Cluster CIDR is required')
    }
    if (!get(this, 'config.ocneVersion')) {
      errors.push('OCNE Version is required')
    }
    if (!get(this, 'config.etcdImageTag')) {
      errors.push('ETCD Image Tag is required')
    }
    if (!get(this, 'config.corednsImageTag')) {
      errors.push('CoreDNS Image Tag is required')
    }
    if (!get(this, 'config.tigeraImageTag')) {
      errors.push('Tigera Operator Image Tag is required')
    }
    if (!get(this, 'config.kubernetesVersion')) {
      errors.push('Kubernetes Version is required')
    }
    if (!get(this, 'config.podCidr')) {
      errors.push('Pod CIDR is required')
    }
    if (get(this, 'config.skipOcneInstall')) {
      if (!get(this, 'config.imageId')) {
        errors.push('Node Image Override is required when skipping OCNE installation')
      }
    }

    if (get(this, 'config.numControlPlaneNodes') % 2 === 0) {
      errors.push('Control Plane replicas cannot be an even number.')
    }

    const yamls = get(this, 'config.applyYamls')

    if (yamls) {
      // only allow up to 500kb of YAML
      if (new Blob(yamls).size > 500000) {
        errors.push('Combined additional YAML manifests may not exceed 500kb in size.')
      }
    }

    // Set the array of errors for display,
    // and return true if saving should continue.
    if (get(errors, 'length')) {
      set(this, 'errors', errors);

      return false;
    } else {
      set(this, 'errors', null);

      return true;
    }
  },
  isWellFormedOCID(property, type) {
    return get(this, property).startsWith(`ocid1.${ type }`);
  },
  mapObjectToContent(options) {
    let content = []

    if (options) {
      for (const [key, value] of Object.entries(options)) {
        content.push({
          label: key,
          value
        })
      }
    }

    return content
  },
  mapToContent(folderOptions) {
    if (folderOptions && typeof folderOptions.map === 'function') {
      return folderOptions.map((option) => ({
        label: option,
        value: option
      }));
    }
  },
  willSave() {
    return this._super(...arguments);
  },
  newRandomizedName() {
    var npName = ''
    const maxLen = 5

    while (npName.length < maxLen) {
      // 36 bits ==> alphanumeric
      const ch = Math.random().toString(36).slice(2);

      npName += ch.slice(0, Math.min(ch.length, (maxLen - npName.length)));
    }

    return `${  npName }`
  },
  loadValues() {
    this.deserializeNodePools()
    this.loadYAMLS()
  },
  saveValues() {
    set(this, 'config.displayName', get(this, 'cluster.name'))
    // Set the Quick Create VCN Flag if using a Quick Create VCN
    set(this, 'config.quickCreateVcn', get(this, 'vcnCreationMode') === 'Quick')
    // Set the Verrazzano Tag depending on the Verrazzano Version, if it is not already set
    const verrazzanoVersion = get(this, 'config.verrazzanoVersion')
    const verrazzanoTag = get(this, 'verrazzanoVersions')[verrazzanoVersion]

    if (verrazzanoTag) {
      set(this, 'config.verrazzanoTag', verrazzanoTag)
    }
    this.serializeNodePools()
    this.saveYAMLs()
  },
  serializeNodePools() {
    const nodePools = get(this, 'nodePools')
    let serialized = []

    const parseIntStrict = function(val) {
      if (val) {
        return parseInt(val)
      }

      return val
    }

    if (nodePools) {
      for (let i = 0; i < nodePools.length; i++) {
        nodePools[i].ocpus = parseIntStrict(nodePools[i].ocpus)
        nodePools[i].memory = parseIntStrict(nodePools[i].memory)
        nodePools[i].replicas = parseIntStrict(nodePools[i].replicas)
        nodePools[i].volumeSize = parseIntStrict(nodePools[i].volumeSize)
        serialized.push(JSON.stringify(nodePools[i]))
      }
    }

    set(this, 'config.nodePools', serialized)
  },
  deserializeNodePools() {
    const serialized = get(this, 'config.nodePools')
    let deserialized = A()

    if (serialized) {
      for (let i = 0; i < serialized.length; i++) {
        deserialized.pushObject(JSON.parse(serialized[i]))
      }
    }

    set(this, 'nodePools', deserialized)
  },
  saveYAMLs() {
    const yamls = get(this, 'yamls')
    let applyYamls = []

    if (yamls) {
      for (let i = 0; i < yamls.length; i++) {
        applyYamls.push(yamls[i].body)
      }
    }
    set(this, 'config.applyYamls', applyYamls)
  },
  loadYAMLS() {
    const serialized = get(this, 'config.applyYamls')
    let deserialized = A()

    if (serialized) {
      for (let i = 0; i < serialized.length; i++) {
        deserialized.pushObject({
          name: this.newRandomizedName(),
          body: serialized[i],
        })
      }
    }

    set(this, 'yamls', deserialized)
  }
});

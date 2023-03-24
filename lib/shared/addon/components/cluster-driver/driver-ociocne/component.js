import Component from '@ember/component'
import ClusterDriver from 'shared/mixins/cluster-driver';
import layout from './template';
import { equal } from '@ember/object/computed'
import { get, set, computed, setProperties } from '@ember/object';
import { inject as service } from '@ember/service';
import { hash } from 'rsvp';
import { OCI_REGIONS } from 'shared/utils/oci';
import { compare } from 'shared/utils/parse-version';

const vcnIdMap = { quick: 'Quick Create', }

const subnetAccessMap = {
  public:  'Public',
  private: 'Private',
}

const supportedVersions = [
  'v1.24.8',
  'v1.23.14',
]

export default Component.extend(ClusterDriver, {
  intl:              service(),
  layout,
  configField:       'ociocneEngineConfig',
  instanceConfig:    '',
  step:              1,
  lanChanged:        null,
  refresh:           false,
  vcnCreationMode:   'none',
  vpcs:              null,
  subnets:           null,
  eipIds:            null,
  nodeFlavors:       null,
  keypairs:          null,
  availableZones:    null,
  authRegionChoices: OCI_REGIONS,
  isNew:             equal('mode', 'new'),
  editing:           equal('mode', 'edit'),

  init() {
    this._super(...arguments);
    set(this, 'kubernetesVersions', supportedVersions);
    let config = get(this, 'cluster.ociocneEngineConfig');

    if ( !config ) {
      config = this.get('globalStore').createRecord({
        type:                  'ociocneEngineConfig',
        secretKey:             '',
        clusterName:           '',
        vcnCidr:               '10.0.0.0/16',
        region:                'us-ashburn-1',
        nodeShape:             'VM.Standard.E4.Flex',
        controlPlaneShape:     'VM.Standard.E4.Flex',
        nodeImage:             'ocid1.image.oc1.iad.aaaaaaaaorro6lk6mljfs3dafptdskbupyjjbindwgqc6nf4ohbe3ucklrqq',
        vcn:                   '',
        securityListId:        '',
        kubernetesVersion:     supportedVersions[0],
        cpSubnetAccess:        'public',
        npSubnetAccess:        'private',
        flexOcpus:             0,
        memory:                0,
        numWorkerNodes:        1,
        numControlPlaneNodes:  1,
        compartmentId:         '',
        quantityOfNodeSubnets: 1,
      });

      set(this, 'cluster.ociocneEngineConfig', config);
    }

    // init cpu and memory
    const {
      cpu,
      memory
    } = get(this, 'config');

    if (cpu && memory) {
      set(this, 'instanceConfig', `${ get(this, 'config.cpu') }/${ get(this, 'config.memory') }`);
    }
  },

  actions: {
    saveStep1(cb) {
      const store = get(this, 'globalStore')
      const data = {
        tenancyOCID:          get(this, 'cluster.ociocneEngineConfig.tenancyId'),
        userOCID:             get(this, 'cluster.ociocneEngineConfig.userOcid'),
        region:               get(this, 'cluster.ociocneEngineConfig.region'),
        fingerprint:          get(this, 'cluster.ociocneEngineConfig.fingerprint'),
        privateKey:           get(this, 'cluster.ociocneEngineConfig.privateKeyContents'),
        privateKeyPassphrase: get(this, 'cluster.ociocneEngineConfig.privateKeyPassphrase'),
        compartmentOCID:      get(this, 'cluster.ociocneEngineConfig.compartmentId')
      };


      const ociRequest = {
        nodeShapes: store.rawRequest({
          url:    '/meta/oci/nodeShapes',
          method: 'POST',
          data
        })
      }

      return hash(ociRequest).then((resp) => {
        const { nodeShapes } = resp;

        setProperties(this, {
          nodeShapes:           (get( nodeShapes, 'body') || [] ).reverse(),
          errors:       [],
        });

        set(this, 'step', 2);
        cb(true);
      }).catch((xhr) => {
        const err = xhr.body.message || xhr.body.code || xhr.body.error;

        setProperties(this, { errors: [err], });

        cb(false, [err]);
      });
    },
    saveNetworking(cb) {
      set(this, 'step', 3);
      cb(true)
    },
    upgradeCluster(cb) {
      setProperties(this, { 'errors': null });

      const errors = get(this, 'errors') || [];
      const intl = get(this, 'intl');

      const quantityPerSubnet = get(this, 'config.quantityPerSubnet');
      const kubernetesVersion = get(this, 'config.kubernetesVersion');

      if (!quantityPerSubnet) {
        errors.push(intl.t('clusterNew.ociocne.quantityPerSubnet.required'));
      } else {
        const maxNodeCount = get(this, 'config.maxNodeCount');

        if (!/^\d+$/.test(quantityPerSubnet) || parseInt(quantityPerSubnet, 10) < 0 || parseInt(quantityPerSubnet, 10) > maxNodeCount) {
          errors.push(intl.t('clusterNew.ociocne.quantityPerSubnet.error', { max: maxNodeCount }));
        }
      }
      if (!kubernetesVersion) {
        errors.push(intl.t('clusterNew.ociocne.version.required'));
      }

      if (errors.length > 0) {
        set(this, 'errors', errors);
        cb();

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
      if (!this.validate()) {
        cb(false);

        return;
      }

      if (!get(this, 'config.useNodePvEncryption')) {
        set(this, 'config.useNodePvEncryption', true);
      }

      this.send('driverSave', cb);
    },
    cancel() {
      get(this, 'router').transitionTo('global-admin.clusters.index');
    },
    cpuAndMemoryChanged(item) {
      setProperties(this, {
        'config.cpu':    item.raw.cpuCount,
        'config.memory': item.raw.memoryCapacityInGB
      });
    }
  },
  maxNodeCount: computed('clusterQuota.slave', () => {
    return 256;
  }),
  vcnChoices: Object.entries(vcnIdMap).map((e) => ({
    label: e[1],
    value: e[0]
  })),
  selectedVCN: computed('config.vcnId', function() {
    const vcnId = get(this, 'config.vcnId');

    return vcnId && vcnIdMap[vcnId];
  }),
  subnetAccessChoices: Object.entries(subnetAccessMap).map((e) => ({
    label: e[1],
    value: e[0]
  })),
  selectedSubnetAccess: computed('config.npSubnetAccess', function() {
    const subnetAccess = get(this, 'config.npSubnetAccess');

    return subnetAccess && subnetAccessMap[subnetAccess];
  }),
  selectedControlPlaneSubnetAccess: computed('config.cpSubnetAccess', function() {
    const cpSubnetAccess = get(this, 'config.cpSubnetAccess');

    return cpSubnetAccess && subnetAccessMap[cpSubnetAccess];
  }),
  canAuthenticate: computed('config.tenancyId', 'config.region', 'config.userOcid', 'config.fingerprint', 'config.privateKeyContents', function() {
    return get(this, 'config.tenancyId') && get(this, 'config.region') && get(this, 'config.userOcid') && get(this, 'config.fingerprint') && get(this, 'config.privateKeyContents') ? false : true;
  }),
  canAddK8sVersion: computed('config.kubernetesVersion', 'config.compartmentId', function() {
    return !(get(this, 'config.compartmentId') && get(this, 'config.kubernetesVersion'));
  }),
  canCreateCluster: computed('config.nodeShape', 'config.nodeImage', function() {
    return !(get(this, 'config.nodeShape') && get(this, 'config.nodeImage'));
  }),
  isFlex: computed('config.nodeShape', function() {
    return (get(this, 'config.nodeShape').includes('Flex'));
  }),

  // Add custom validation beyond what can be done from the config API schema
  validate() {
    // Get generic API validation errors
    this._super();
    var errors = get(this, 'errors') || [];

    if (!get(this, 'cluster.name')) {
      errors.push('Name is required');
    }

    const tenancyId = get(this, 'config.tenancyId');

    if (!tenancyId.startsWith('ocid1.tenancy')) {
      errors.push('A valid tenancy OCID is required');
    }

    const compartmentId = get(this, 'config.compartmentId');

    if (!compartmentId.startsWith('ocid1.compartment') && !compartmentId.startsWith('ocid1.tenancy')) {
      errors.push('A valid compartment OCID is required');
    }

    const userOcid = get(this, 'config.userOcid');

    if (!userOcid.startsWith('ocid1.user')) {
      errors.push('A valid user OCID is required');
    }

    // TODO Add more specific errors

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
  willSave() {
    if (get(this, 'mode') === 'new') {
      if (get(this, 'config.vcnCompartmentId') === '') {
        set(this, 'config.vcnCompartmentId', get(this, 'config.compartmentId'));
      }
      if (get(this, 'config.vcnName') !== '') {
        set(this, 'config.skipVcnDelete', true);
      }
      if (get(this, 'config.cpSubnetAccess') === 'public') {
        set(this, 'config.enablePrivateControlPlane', false);
      } else {
        set(this, 'config.enablePrivateControlPlane', true);
      }
      if (get(this, 'config.npSubnetAccess') === 'public') {
        set(this, 'config.enablePrivateNodes', false);
      } else {
        set(this, 'config.enablePrivateNodes', true);
      }
    }

    return this._super(...arguments);
  },
});

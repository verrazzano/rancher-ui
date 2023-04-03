import Component from '@ember/component'
import ClusterDriver from 'shared/mixins/cluster-driver';
import layout from './template';
import { equal } from '@ember/object/computed'
import { get, set, computed, setProperties } from '@ember/object';
import { inject as service } from '@ember/service';
import { hash } from 'rsvp';
import { OCI_REGIONS } from 'shared/utils/oci';
import { compare } from 'shared/utils/parse-version';

const supportedVersions = [
  'v1.24.8',
  'v1.23.14',
]

export default Component.extend(ClusterDriver, {
  intl:              service(),
  oci:               service(),
  layout,
  configField:       'ociocneEngineConfig',
  instanceConfig:    '',
  step:              1,
  lanChanged:        null,
  refresh:           false,
  vcnCreationMode:   'Quick',
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
        clusterName:           '',
        vcnCidr:               '10.0.0.0/16',
        region:                'us-ashburn-1',
        nodeShape:             'VM.Standard.E4.Flex',
        controlPlaneShape:     'VM.Standard.E4.Flex',
        imageDisplayName:      '',
        kubernetesVersion:     supportedVersions[0],
        numWorkerNodes:        1,
        numControlPlaneNodes:  1,
        nodeVolumeGbs:         50,
        controlPlaneVolumeGbs: 50,
        vcnId:                 '',
        workerNodeSubnet:      '',
        controlPlaneSubnet:    '',
        loadBalancerSubnet:    '',
        installCalico:         true,
        compartmentId:         '',
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
    async saveStep1(cb) {
      set(this, 'step', 2);
      cb(true);

      let token = get(this, 'primaryResource.cloudCredentialId');
      let compartment = get(this, 'config.compartmentId');

      if (token !== null && token !== '' && compartment !== null && compartment !== ''
        && (compartment.startsWith('ocid1.compartment') || compartment.startsWith('ocid1.tenancy'))) {
        const auth = {
          type: 'cloud',
          token
        };
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
      }
    },
    saveNetworking(cb) {
      const errors = get(this, 'errors') || [];
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

      if (errors.length > 0) {
        set(this, 'errors', errors);
        cb();

        return;
      }

      set(this, 'step', 3);
      cb(true)
    },

    finishAndSelectCloudCredential(credential) {
      set(this, 'model.cloudCredentialId', get(credential, 'id'))
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

      this.send('driverSave', cb);
    },
    cancel() {
      get(this, 'router').transitionTo('global-admin.clusters.index');
    },
  },
  cloudCredentials: computed('globalStore', 'model.cloudCredentials', 'originalSecret', function() {
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
  canChangeNetworking: computed('mode', 'step', function() {
    return get(this, 'mode') === 'new' && get(this, 'step') === 2
  }),
  canCreateCluster: computed('config.{controlPlaneShape,imageDisplayName,nodeShape}', function() {
    return !(get(this, 'config.nodeShape') && get(this, 'config.controlPlaneShape') && get(this, 'config.imageDisplayName'));
  }),
  isWorkerNodeFlex: computed('config.nodeShape', function() {
    const shape = get(this, 'config.nodeShape');

    return shape && shape.includes('Flex');
  }),
  isControlPlaneFlex: computed('config.controlPlaneShape', function() {
    const shape = get(this, 'config.controlPlaneShape');

    return shape && shape.includes('Flex');
  }),
  // Add custom validation beyond what can be done from the config API schema
  validate() {
    // Get generic API validation errors
    this._super();
    var errors = get(this, 'errors') || [];

    if (!get(this, 'cluster.name')) {
      errors.push('Cluster Name is required');
    }

    if (!get(this, 'config.nodePublicKeyContents')) {
      errors.push('SSH public key is required')
    }

    const compartmentId = get(this, 'config.compartmentId');

    if (!compartmentId.startsWith('ocid1.compartment') && !compartmentId.startsWith('ocid1.tenancy')) {
      errors.push('A valid compartment OCID is required');
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
  isWellFormedOCID(property, type) {
    return get(this, property).startsWith(`ocid1.${ type }`);
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
    if (get(this, 'mode') === 'new') {
    }

    return this._super(...arguments);
  },
});

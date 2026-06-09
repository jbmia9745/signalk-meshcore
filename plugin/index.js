module.exports = (app) => {
  const plugin = {};
  plugin.id = 'signalk-meshcore';
  plugin.name = 'MeshCore';
  plugin.description = 'Connect Signal K with the MeshCore LoRa mesh network';

  plugin.start = () => {
    app.setPluginStatus('Not implemented yet');
  };

  plugin.stop = () => {};

  plugin.schema = () => ({
    type: 'object',
    properties: {
      device: {
        type: 'object',
        title: 'MeshCore device connection settings',
        properties: {
          transport: {
            type: 'string',
            default: 'tcp',
            title: 'How to connect to the boat MeshCore companion radio',
            oneOf: [
              {
                const: 'tcp',
                title: 'TCP (radio on same network, WiFi companion firmware)',
              },
              {
                const: 'serial',
                title: 'Serial port (use full path to serial device as "address")',
              },
            ],
          },
          address: {
            type: 'string',
            title: 'Address of the MeshCore radio (host or serial device path)',
          },
          port: {
            type: 'integer',
            default: 5000,
            title: 'TCP port (TCP transport only)',
          },
        },
      },
    },
  });

  return plugin;
};

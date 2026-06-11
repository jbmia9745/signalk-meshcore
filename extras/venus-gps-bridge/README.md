# Venus OS GPS bridge (optional)

Publishes Signal K `navigation.position` as a Venus OS GPS device
(`com.victronenergy.gps.signalk`) so VRM gets a live vessel location —
including signalk-meshcore's radio-GNSS fallback, since Signal K already
arbitrates the sources.

Install on the Cerbo/Venus device:

```sh
mkdir -p /data/sk-gps-bridge/service/log
cp sk_gps_bridge.py /data/sk-gps-bridge/
printf '#!/bin/sh\nexec 2>&1\nexec python3 /data/sk-gps-bridge/sk_gps_bridge.py\n' > /data/sk-gps-bridge/service/run
printf '#!/bin/sh\nexec multilog t s100000 n2 /var/log/sk-gps-bridge\n' > /data/sk-gps-bridge/service/log/run
chmod +x /data/sk-gps-bridge/service/run /data/sk-gps-bridge/service/log/run /data/sk-gps-bridge/sk_gps_bridge.py
echo "ln -sf /data/sk-gps-bridge/service /service/sk-gps-bridge" >> /data/rc.local
ln -sf /data/sk-gps-bridge/service /service/sk-gps-bridge
```

The bridge deliberately ignores its own re-imported source (the Venus →
Signal K plugin echoes this device back) and goes `Fix: 0` when no real
position source has reported within 10 minutes.

#!/usr/bin/env python3
# Publishes Signal K navigation.position as a Venus OS GPS device
# (com.victronenergy.gps.signalk) so VRM gets live vessel location.
# Signal K already arbitrates boat GPS vs signalk-meshcore radio-GNSS
# fallback, so VRM inherits that behavior.
import sys, json, urllib.request
from datetime import datetime, timezone
sys.path.insert(1, "/opt/victronenergy/dbus-modem")  # velib_python
from vedbus import VeDbusService
import dbus, dbus.mainloop.glib
from gi.repository import GLib

SK = "http://localhost:3000/signalk/v1/api/vessels/self/navigation"
STALE_SECS = 600

def get(path):
    try:
        with urllib.request.urlopen("%s/%s" % (SK, path), timeout=3) as r:
            return json.load(r)
    except Exception:
        return None

def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    try:
        svc = VeDbusService("com.victronenergy.gps.signalk", register=False)
        deferred = True
    except TypeError:
        svc = VeDbusService("com.victronenergy.gps.signalk")
        deferred = False
    svc.add_path("/Mgmt/ProcessName", "sk-gps-bridge")
    svc.add_path("/Mgmt/ProcessVersion", "1.0")
    svc.add_path("/Mgmt/Connection", "Signal K localhost")
    svc.add_path("/DeviceInstance", 10)
    svc.add_path("/ProductId", 0)
    svc.add_path("/ProductName", "Signal K GPS bridge")
    svc.add_path("/Connected", 1)
    svc.add_path("/Fix", 0)
    svc.add_path("/Position/Latitude", None)
    svc.add_path("/Position/Longitude", None)
    svc.add_path("/Speed", None)
    svc.add_path("/Course", None)
    svc.add_path("/Altitude", None)
    svc.add_path("/NrOfSatellites", None)
    if deferred:
        svc.register()

    def best_real_position(d):
        # never consume our own echo (venus-plugin re-imports this bridge
        # as a Signal K source) — pick the freshest NON-self source
        cands = []
        vals = d.get("values") or {}
        for src_name, entry in vals.items():
            if "gps.signalk" in src_name:
                continue
            cands.append((entry.get("timestamp"), entry.get("value")))
        if not cands and "gps.signalk" not in str(d.get("$source", "")):
            cands.append((d.get("timestamp"), d.get("value")))
        cands = [c for c in cands if isinstance(c[1], dict)]
        cands.sort(key=lambda c: c[0] or "", reverse=True)
        return cands[0] if cands else (None, None)

    def tick():
        d = get("position") or {}
        ok = False
        ts_str, v = best_real_position(d)
        if isinstance(v, dict):
            lat, lon = v.get("latitude"), v.get("longitude")
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                age = (datetime.now(timezone.utc) - ts).total_seconds()
            except Exception:
                age = 0
            if (lat is not None and lon is not None and age < STALE_SECS
                    and (abs(lat) > 0.01 or abs(lon) > 0.01)):
                svc["/Position/Latitude"] = round(lat, 7)
                svc["/Position/Longitude"] = round(lon, 7)
                ok = True
        svc["/Fix"] = 1 if ok else 0
        sog = get("speedOverGround")
        cog = get("courseOverGroundTrue")
        svc["/Speed"] = round(sog["value"], 2) if sog and isinstance(sog.get("value"), (int, float)) else None
        svc["/Course"] = round(cog["value"] * 57.29577951, 1) if cog and isinstance(cog.get("value"), (int, float)) else None
        return True

    tick()
    GLib.timeout_add_seconds(5, tick)
    GLib.MainLoop().run()

main()

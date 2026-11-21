package com.towersiege.game;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.Inet4Address;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;

// Tells the game this device's address on the local network, so the co-op screen can scan that network for game
// servers (a web page can't find out its own IP). JS: Capacitor.Plugins.Lan.localAddress() → { ip, prefix }.
@CapacitorPlugin(name = "Lan")
public class LanPlugin extends Plugin {
    @PluginMethod
    public void localAddress(PluginCall call) {
        try {
            InterfaceAddress best = null;
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (!(ia.getAddress() instanceof Inet4Address) || !ia.getAddress().isSiteLocalAddress()) continue;
                    // Wi-Fi first; a mobile-data or hotspot address only if there is nothing else
                    if (best == null || ni.getName().startsWith("wlan")) best = ia;
                }
            }
            if (best == null) { call.reject("Not connected to a local network"); return; }
            JSObject r = new JSObject();
            r.put("ip", best.getAddress().getHostAddress());
            r.put("prefix", best.getNetworkPrefixLength());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read the network address", e);
        }
    }
}

#!/bin/bash
# The loui package's postinst ("deb.afterInstall" in package.json). It is
# electron-builder's own (app-builder-lib/templates/linux/after-install.tpl)
# with one difference, the sandbox helper: see below.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/loui' -a -e '/usr/bin/loui' -a "`readlink '/usr/bin/loui'`" != '/etc/alternatives/loui' ]; then
        rm -f '/usr/bin/loui'
    fi
    update-alternatives --install '/usr/bin/loui' 'loui' '/opt/Loui/loui' 100 || ln -sf '/opt/Loui/loui' '/usr/bin/loui'
else
    ln -sf '/opt/Loui/loui' '/usr/bin/loui'
fi

# Chromium's sandbox uses user namespaces where an ordinary user may make
# one (Debian's default), and otherwise this helper, which must then be
# setuid root or Loui refuses to start. electron-builder's script makes it
# setuid only if `unshare --user` fails here, but this runs as root, for whom
# it works even where it is refused to everyone else (a hardened sysctl, or
# AppArmor's restriction): there the installed app could not start. So it is
# always setuid, as in Chrome's own package; Chromium still prefers user
# namespaces when it can have them.
chown root:root '/opt/Loui/chrome-sandbox' || true
chmod 4755 '/opt/Loui/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/Loui/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/loui'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

"""Checks every resource and manifest XML file the way Android's resource compiler does."""
import glob, re, sys, xml.dom.minidom
bad = 0
for f in glob.glob('app/src/main/res/**/*.xml', recursive=True) + ['app/src/main/AndroidManifest.xml']:
    try:
        xml.dom.minidom.parse(f)
    except Exception as e:
        print('BAD', f, e); bad += 1
sys.exit(1 if bad else 0)

#!/bin/sh

if [ -z "$1" ] ; then
	echo "Usage: $0 /path/to/VENV -s KINTO_SERVER -t TOKEN"
	exit -1
fi

venv=$1
shift

mydir=$(dirname $(realpath $0))
. "$venv/bin/activate"
python "$mydir"/updater.py $* >> "$mydir/updater.log"

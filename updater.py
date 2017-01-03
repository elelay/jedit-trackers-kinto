#!/usr/bin/python3
import datetime
import argparse

import requests

import kinto_http
from kinto_http import Client

parser = argparse.ArgumentParser(description='jEdit trackers Kinto DB updater.')
parser.add_argument('-s', '--server', default="http://localhost:8888",
                   help='kinto server (without the /v1)')
parser.add_argument('-t', '--token', required=True,
                   help='Authentication token')

args = parser.parse_args()

server = args.server;
token = args.token;
bucket = "jedit-trackers";

print("Updating %s/v1/buckets/%s" % (server, bucket))

client = Client(server_url= server + "/v1",
                auth=('token', token))

client.create_bucket(bucket, if_not_exists=True)
client.create_collection('updater', bucket=bucket, if_not_exists=True)

rt = requests.get("https://sourceforge.net/rest/p/jedit/")
jsont = rt.json()
trackers = [tool for tool in jsont['tools'] if tool['name'] == 'tickets']

last_updater = client.create_record({'id':"last", 'last_date':"2016-08-11T00:00:00Z"}, bucket=bucket, collection="updater", if_not_exists=True)
last_date = last_updater['data']['last_date']
print("last_date: %s" % last_date)

now_date = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

print("now: %s" % now_date)
for tool in trackers:
    t = tool['mount_point']
#    url = "https://sourceforge.net/rest/p/jedit/%s/?orderBy=mod_date_dt&order=desc&limit=10" % t
    url = "https://sourceforge.net/rest/p/jedit/%s/search?q=mod_date_dt:[%s TO %s]" % (t, last_date, now_date)
    print("Fetching %s..." % url)
    r = requests.get(url)
    print("%s: status %i" % (t, r.status_code))
    if r.status_code is 200:
        json = r.json()
        print("%s: found %i tickets" % (t, json["count"]))
        for ticket in json['tickets']:
            ticket['id'] = ticket['_id']
            del ticket['_id']
            ticket['tracker_id'] = t
            ticket['tracker_label'] = tool['mount_label']
            rd = requests.get(ticket['discussion_thread_url'])
            if rd.status_code is 200:
                jsont = rd.json()
                ticket["discussion_thread"] = jsont['thread']
        
        print("%s: updating %i tickets" % (t, len(json['tickets'])))
        with client.batch() as batch:
            for ticket in json['tickets']:
                batch.update_record(ticket, bucket=bucket, collection="tickets")

last_updater['data']['last_date'] = now_date
# comment to disable update while testing
client.update_record(last_updater['data'], bucket=bucket, collection='updater')
print("DONE")
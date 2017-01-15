import argparse
import json
import logging
import sys
import traceback
import requests

from kinto_http import Client

from socketIO_client import SocketIO, LoggingNamespace

logger = logging.getLogger('socketIO-Updater')

def get_trackers():
    trackers = {}
    rt = requests.get("https://sourceforge.net/rest/p/jedit/")
    rt.raise_for_status()
    jsont = rt.json()
    for tracker in jsont['tools']:
        if tracker['name'] == 'tickets':
            trackers[tracker['mount_point']] = tracker['mount_label']
    logger.debug("trackers: %r" % trackers)
    return trackers


def update_ticket(ticket):
    client = Client(server_url=(server + "/v1"),
                    auth=('token', token))
    logger.debug("updating ticket %s in kinto" % ticket['summary'])
    client.update_record(ticket,
                         bucket=bucket,
                         collection="tickets")
    logger.info("%s DONE" % ticket['summary'])


def on_ticket_update(data):
    logger.info('on_ticket_update %r' % data)
    tracker = data['tracker']
    num = data['number']
    path = "%s/%s" % (tracker, num)
    try:
        url = "https://sourceforge.net/rest/p/jedit/%s" % path
        r = requests.get(url)
        r.raise_for_status()
        jsont = r.json()
        logger.debug("successfully loaded ticket %s" % path)
        if jsont.get('ticket', {}).get('summary'):
            ticket = jsont['ticket']
            logger.debug("ticket update %s" % ticket['summary'])
            ticket['id'] = ticket['_id']
            del ticket['_id']
            ticket['tracker_id'] = tracker
            ticket['tracker_label'] = trackers[tracker]
            try:
                update_ticket(ticket)
            except:
                logger.exception("updating ticket %s" % path)
        else:
            raise Exception("Invalid response from %s :%s"
                            % json.dumps(jsont, indent=2))
    except:
        logger.exception("fetching ticket from %s" % url)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='jEdit trackers Kinto DB updater.')
    parser.add_argument('-i', '--socketio', default="http://localhost:8000",
                       help='socket.io endpoint')
    parser.add_argument('-s', '--server', default="http://localhost:8888",
                       help='kinto server (without the /v1)')
    parser.add_argument('-t', '--token', required=True,
                       help='Authentication token')
    parser.add_argument('-d', '--debug', action='store_true',
                       help='enable debugging')
    
    args = parser.parse_args()
    
    if args.debug:
        logging.getLogger('socketIO-client').setLevel(logging.DEBUG)
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.INFO)
    logging.basicConfig()


    server = args.server;
    token = args.token;
    bucket = "jedit-trackers";
    
    trackers = get_trackers()
    
    logger.info("Pushing ticket updates to %s/v1/buckets/%s" % (server, bucket))
    
    socketIO = SocketIO(args.socketio, Namespace=LoggingNamespace)
    socketIO.on('ticket', on_ticket_update)
    
    socketIO.wait()
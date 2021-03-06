/*
 * #%L
 * mosaic-examples-realtime-feeds-frontend
 * %%
 * Copyright (C) 2010 - 2012 Institute e-Austria Timisoara (Romania)
 * %%
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *      http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * #L%
 */

package eu.mosaic_cloud.examples.realtime_feeds.frontend;


import java.io.IOException;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import eu.mosaic_cloud.components.core.ComponentCallReply;
import eu.mosaic_cloud.components.httpg.jetty.container.JettyComponent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.basho.riak.pbc.RiakClient;
import com.basho.riak.pbc.RiakObject;
import com.google.common.base.Preconditions;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.ShutdownListener;
import com.rabbitmq.client.ShutdownSignalException;


@SuppressWarnings ("serial")
public final class FeedsServlet
		extends JsonServlet
{
	public FeedsServlet ()
	{
		this.feedBucket = "feed-metadata";
		this.feedExchange = "feeds.fetch-data";
		this.feedRoutingKey = "urgent";
		this.feedLimit = 10;
		final JettyComponent component = JettyComponent.get ();
		if (component.isStandalone ()) {
			try {
				{
					final ComponentCallReply reply = component.call (FeedsServlet.defaultRabbitGroup, "mosaic-rabbitmq:get-broker-endpoint", null).get (12000, TimeUnit.MILLISECONDS);
					Preconditions.checkState (reply.ok);
					final Map<?, ?> outputs = (Map<?, ?>) reply.outputsOrError;
					this.rabbitAddr = (String) outputs.get ("ip");
					this.rabbitPort = ((Integer) outputs.get ("port")).intValue ();
					FeedsServlet.logger.info ("resolved Rabbit on `{}:{}`", this.rabbitAddr, Integer.valueOf (this.rabbitPort));
				}
				{
					final ComponentCallReply reply = component.call (FeedsServlet.defaultRiakGroup, "mosaic-riak-kv:get-store-pb-endpoint", null).get (12000, TimeUnit.MILLISECONDS);
					Preconditions.checkState (reply.ok);
					final Map<?, ?> outputs = (Map<?, ?>) reply.outputsOrError;
					this.riakAddr = (String) outputs.get ("ip");
					this.riakPort = ((Integer) outputs.get ("port")).intValue ();
					FeedsServlet.logger.info ("resolved Riak on `{}:{}`", this.riakAddr, Integer.valueOf (this.riakPort));
				}
			} catch (final Throwable e) {
				FeedsServlet.logger.error ("failed resolving resources; terminating!", e);
				component.terminate ();
				throw (new IllegalStateException ());
			}
		} else {
			this.riakAddr = "127.0.0.1";
			this.riakPort = 22652;
			this.rabbitAddr = "127.0.0.1";
			this.rabbitPort = 21688;
		}
		try {
			{
				this.riakClient = new RiakClient (this.riakAddr, this.riakPort);
			}
			{
				final ConnectionFactory factory = new ConnectionFactory ();
				factory.setHost (this.rabbitAddr);
				factory.setPort (this.rabbitPort);
				this.rabbitConnection = factory.newConnection ();
				this.rabbitChannel = this.rabbitConnection.createChannel ();
				this.rabbitChannel.addShutdownListener (new ShutdownListener () {
					@Override
					public void shutdownCompleted (final ShutdownSignalException e)
					{
						FeedsServlet.logger.error ("Rabbit failed; terminating!", e);
						component.terminate ();
					}
				});
			}
		} catch (final Exception e) {
			FeedsServlet.logger.error ("failed resolving resources; terminating!", e);
			component.terminate ();
			throw (new IllegalStateException ());
		}
	}
	
	@Override
	protected final JSONObject handleRequest (final JSONObject jsonRequest)
			throws JSONException,
				IOException
	{
		final String action = jsonRequest.getString ("action");
		if (action.equals ("register") || action.equals ("refresh")) {
			final String url = jsonRequest.getJSONObject ("arguments").getString ("url");
			final String seq = jsonRequest.getJSONObject ("arguments").getString ("sequence");
			return this.buildFeedReply (this.generateKey (url), url, seq);
		}
		final JSONObject act = new JSONObject ();
		act.put ("action", "not supported");
		return act;
	}
	
	private final JSONObject buildFeedReply (final String md5, final String url, final String seque)
			throws JSONException,
				IOException
	{
		final int seq = Integer.parseInt (seque);
		this.pushFeedRequest (url);
		JSONObject feed = new JSONObject ();
		final JSONObject result = new JSONObject ();
		final JSONArray jsonArr = new JSONArray ();
		final RiakObject[] feeds = this.riakClient.fetch (this.feedBucket, md5);
		int sequence = 0;
		if (feeds.length > 0) {
			feed = new JSONObject (feeds[0].getValue ().toStringUtf8 ());
			sequence = feed.getInt ("sequence");
		}
		result.put ("sequence", sequence);
		int count = 0;
		out : while (true) {
			if (sequence <= seq) {
				break;
			}
			final String hexa = String.format ("#%08x", Integer.valueOf (sequence));
			final String timeLineKey = this.generateKey (url + hexa);
			final RiakObject[] feedTimeLine = this.riakClient.fetch ("feed-timelines", timeLineKey);
			if (feedTimeLine.length == 0) {
				continue out;
			}
			final JSONObject feedItem = new JSONObject (feedTimeLine[0].getValue ().toStringUtf8 ());
			final JSONArray feedItems = feedItem.getJSONArray ("items");
			for (int index = 0; index < feedItems.length (); index++) {
				JSONObject tempObj = new JSONObject ();
				final String itemKey = feedItems.getString (index);
				final RiakObject riakFeedJson = this.riakClient.fetch ("feed-items", itemKey)[0];
				final JSONObject feedJson = new JSONObject (riakFeedJson.getValue ().toStringUtf8 ());
				tempObj.put ("img", feedJson.getJSONArray ("links:image").getString (0));
				tempObj.put ("title", feedJson.getString ("title"));
				tempObj.put ("link", feedJson.getString ("author:uri"));
				jsonArr.put (tempObj);
				count++;
				if (count >= this.feedLimit) {
					break out;
				}
				tempObj = null;
			}
			sequence--;
		}
		result.put ("entry", jsonArr);
		return result;
	}
	
	private final String generateKey (final String string)
	{
		try {
			final MessageDigest md5 = MessageDigest.getInstance ("MD5");
			md5.update (string.getBytes (), 0, string.length ());
			final BigInteger i = new BigInteger (1, md5.digest ());
			final String timelineKey = String.format ("%1$032X", i).toLowerCase ();
			return timelineKey;
		} catch (final Exception e) {
			throw (new IllegalStateException ());
		}
	}
	
	private final void pushFeedRequest (final String url)
			throws JSONException,
				IOException
	{
		final JSONObject request = new JSONObject ();
		request.put ("url", url);
		final AMQP.BasicProperties prop = new AMQP.BasicProperties.Builder ().contentType ("application/json").build ();
		synchronized (this.rabbitChannel) {
			this.rabbitChannel.basicPublish (this.feedExchange, this.feedRoutingKey, prop, request.toString ().getBytes ());
		}
	}
	
	private final String feedBucket;
	private final String feedExchange;
	private final int feedLimit;
	private final String feedRoutingKey;
	private final String rabbitAddr;
	private final Channel rabbitChannel;
	private final Connection rabbitConnection;
	private final int rabbitPort;
	private final String riakAddr;
	private final RiakClient riakClient;
	private final int riakPort;
	public static final String defaultRabbitGroup = "8cd74b5e4ecd322fd7bbfc762ed6cf7d601eede8";
	public static final String defaultRiakGroup = "9cdce23e78027ef6a52636da7db820c47e695d11";
	private static final Logger logger = LoggerFactory.getLogger (FeedsServlet.class);
}

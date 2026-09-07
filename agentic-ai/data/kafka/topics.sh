#!/bin/bash
# Create AURA-NET Kafka topics
kafka-topics.sh --create --topic aura.event.v1 --partitions 3 --replication-factor 1 --bootstrap-server kafka:9092
kafka-topics.sh --create --topic aura.kpi.v1   --partitions 6 --replication-factor 1 --bootstrap-server kafka:9092

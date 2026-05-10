#!/bin/bash
# Create AURA-NET bucket and retention policy
influx bucket create --name aura_net --retention 7d

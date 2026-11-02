#!/bin/sh
set -eu

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_URL="$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

WAGER_URL="$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)"
# Existing LocalStack volumes retain queues from previous starts. Set the
# policy explicitly so restarts converge on the documented topology.
awslocal sqs set-queue-attributes --queue-url "$WAGER_URL" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

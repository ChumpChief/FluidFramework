/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { requireAssignableTo } from "@fluidframework/build-tools";

import type { SimpleCell, SimpleCellView } from "../../simpleCell.js";
import type { SimpleCellChannel } from "../../simpleCellChannel.js";
import type { createSimpleCell } from "../../simpleCellFactory.js";

type ConsumerKeys = "get" | "set" | "delete" | "empty" | "events";
type CreatedCell = ReturnType<typeof createSimpleCell>;

declare type _implementationMatchesView = requireAssignableTo<
	SimpleCell<number>,
	SimpleCellView<number>
>;
declare type _viewHasOnlyConsumerMethods = requireAssignableTo<
	keyof SimpleCellView,
	ConsumerKeys
>;
declare type _viewHasAllConsumerMethods = requireAssignableTo<
	ConsumerKeys,
	keyof SimpleCellView
>;
declare type _createdValueIsScoped = requireAssignableTo<
	keyof CreatedCell["value"],
	ConsumerKeys
>;
declare type _createdHandleValueIsScoped = requireAssignableTo<
	keyof Awaited<ReturnType<CreatedCell["handle"]["get"]>>,
	ConsumerKeys
>;
declare type _channelEntryPointIsScoped = requireAssignableTo<
	keyof SimpleCellChannel["entryPoint"],
	ConsumerKeys
>;
declare type _channelHandleValueIsScoped = requireAssignableTo<
	keyof Awaited<ReturnType<SimpleCellChannel["handle"]["get"]>>,
	ConsumerKeys
>;

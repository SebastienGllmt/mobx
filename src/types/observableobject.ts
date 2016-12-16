import {ObservableValue, UNCHANGED} from "./observablevalue";
import {isComputedValue, ComputedValue} from "../core/computedvalue";
import {createInstanceofPredicate, isObject, Lambda, getNextId, invariant, assertPropertyConfigurable, isPlainObject, addHiddenFinalProp} from "../utils/utils";
import {runLazyInitializers} from "../utils/decorators";
import {hasInterceptors, IInterceptable, registerInterceptor, interceptChange} from "./intercept-utils";
import {IListenable, registerListener, hasListeners, notifyListeners} from "./listen-utils";
import {isSpyEnabled, spyReportStart, spyReportEnd} from "../core/spy";
import {IEnhancer, isModifierDescriptor, IModifierDescriptor, deepEnhancer} from "../types/modifiers";

const COMPUTED_FUNC_DEPRECATED = (
`
In MobX 2.* passing a function without arguments to (extend)observable will automatically be inferred to be a computed value.
This behavior is ambiguous and will change in MobX 3 to create just an observable reference to the value passed in.
To disambiguate, please pass the function wrapped with a modifier: use 'computed(fn)' (for current behavior; automatic conversion), or 'asReference(fn)' (future behavior, just store reference) or 'action(fn)'.
Note that the idiomatic way to write computed properties is 'observable({ get propertyName() { ... }})'.
For more details, see https://github.com/mobxjs/mobx/issues/532`);

export interface IObservableObject {
	"observable-object": IObservableObject;
}

// In 3.0, change to IObjectDidChange
export interface IObjectChange {
	name: string;
	object: any;
	type: "update" | "add";
	oldValue?: any;
	newValue: any;
}

export interface IObjectWillChange {
	object: any;
	type: "update" | "add";
	name: string;
	newValue: any;
}

export class ObservableObjectAdministration implements IInterceptable<IObjectWillChange>, IListenable {
	values: {[key: string]: ObservableValue<any>|ComputedValue<any>} = {};
	changeListeners = null;
	interceptors = null;

	constructor(public target: any, public name: string) { }

	/**
		* Observes this object. Triggers for the events 'add', 'update' and 'delete'.
		* See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
		* for callback details
		*/
	observe(callback: (changes: IObjectChange) => void, fireImmediately?: boolean): Lambda {
		invariant(fireImmediately !== true, "`observe` doesn't support the fire immediately property for observable objects.");
		return registerListener(this, callback);
	}

	intercept(handler): Lambda {
		return registerInterceptor(this, handler);
	}
}

export interface IIsObservableObject {
	$mobx: ObservableObjectAdministration;
}

export function asObservableObject(target, name?: string): ObservableObjectAdministration {
	if (isObservableObject(target))
		return (target as any).$mobx;

	invariant(Object.isExtensible(target), "Cannot make the designated object observable; it is not extensible");
	if (!isPlainObject(target))
		name = (target.constructor.name || "ObservableObject") + "@" + getNextId();
	if (!name)
		name = "ObservableObject@" + getNextId();

	const adm = new ObservableObjectAdministration(target, name);
	addHiddenFinalProp(target, "$mobx", adm);
	return adm;
}

export function defineObservablePropertyFromDescriptor(adm: ObservableObjectAdministration, propName: string, descriptor: PropertyDescriptor, defaultEnhancer: IEnhancer<any>) {
	if (adm.values[propName]) {
		// already observable property
		invariant("value" in descriptor, `The property ${propName} in ${adm.name} is already observable, cannot redefine it as computed property`);
		adm.target[propName] = descriptor.value; // the property setter will make 'value' reactive if needed.
		return;
	}

	// not yet observable property

	if ("value" in descriptor) {
		// not a computed value
		if (isModifierDescriptor(descriptor.value)) {
			// x : ref(someValue)
			const modifierDescriptor = descriptor.value as IModifierDescriptor<any>;
			defineObservableProperty(adm, propName, modifierDescriptor.initialValue, modifierDescriptor.enhancer, true);
		}
		// TODO: if is action, name and bind
		else if (isComputedValue(descriptor.value)) {
			// x: computed(someExpr)
			defineComputedPropertyFromComputedValue(adm, propName, descriptor.value, true);
		} else {
			// x: someValue
			defineObservableProperty(adm, propName, descriptor.value, defaultEnhancer, true);
		}
	} else {
		// get x() { return 3 } set x(v) { }
		defineComputedProperty(adm, propName, descriptor.get, descriptor.set, false, true);
	}
}

export function defineObservableProperty(
	adm: ObservableObjectAdministration,
	propName: string,
	newValue,
	enhancer: IEnhancer<any>,
	asInstanceProperty: boolean
) {
	// TODO: heck if asInstanceProperty abstraction is correct? probably always true for observable properties?
	if (asInstanceProperty)
		assertPropertyConfigurable(adm.target, propName);

	if (hasInterceptors(adm)) {
		const change = interceptChange<IObjectWillChange>(adm, {
			object: adm.target,
			name: propName,
			type: "add",
			newValue
		});
		if (!change)
			return;
		newValue = change.newValue;
	}
	const observable = adm.values[propName] = new ObservableValue(newValue, enhancer, `${adm.name}.${propName}`, false);
	newValue = (observable as any).value; // observableValue might have changed it

	if (asInstanceProperty) {
		Object.defineProperty(adm.target, propName, generateObservablePropConfig(propName));
	}
	notifyPropertyAddition(adm, adm.target, propName, newValue);
}

export function defineComputedProperty(
	adm: ObservableObjectAdministration,
	propName: string,
	getter,
	setter,
	compareStructural: boolean,
	asInstanceProperty: boolean
) {
	if (asInstanceProperty) // TODO: always false?
		assertPropertyConfigurable(adm.target, propName);

	adm.values[propName] = new ComputedValue(getter, adm.target, compareStructural, `${adm.name}.${propName}`, setter);
	if (asInstanceProperty) {
		Object.defineProperty(adm.target, propName, generateComputedPropConfig(propName));
	}
}

export function defineComputedPropertyFromComputedValue(adm: ObservableObjectAdministration, propName: string, computedValue: ComputedValue<any>, asInstanceProperty: boolean) {
	let name = `${adm.name}.${propName}`;
	computedValue.name = name;
	if (!computedValue.scope)
		computedValue.scope = adm.target;

	adm.values[propName] = computedValue;
	if (asInstanceProperty)
		Object.defineProperty(adm.target, propName, generateComputedPropConfig(propName));
}

const observablePropertyConfigs = {};
const computedPropertyConfigs = {};

export function generateObservablePropConfig(propName) {
	const config = observablePropertyConfigs[propName];
	if (config)
		return config;
	return observablePropertyConfigs[propName] = {
		configurable: true,
		enumerable: true,
		get: function() {
			return this.$mobx.values[propName].get();
		},
		set: function(v) {
			setPropertyValue(this, propName, v);
		}
	};
}

export function generateComputedPropConfig(propName) {
	const config = computedPropertyConfigs[propName];
	if (config)
		return config;
	return computedPropertyConfigs[propName] = {
		configurable: true,
		enumerable: false,
		get: function() {
			return this.$mobx.values[propName].get();
		},
		set: function(v) {
			return this.$mobx.values[propName].set(v);
		}
	};
}

export function setPropertyValue(instance, name: string, newValue) {
	const adm = instance.$mobx;
	const observable = adm.values[name];

	// intercept
	if (hasInterceptors(adm)) {
		const change = interceptChange<IObjectWillChange>(adm, {
			type: "update",
			object: instance,
			name, newValue
		});
		if (!change)
			return;
		newValue = change.newValue;
	}
	newValue = observable.prepareNewValue(newValue);

	// notify spy & observers
	if (newValue !== UNCHANGED) {
		const notify = hasListeners(adm);
		const notifySpy = isSpyEnabled();
		const change = notify || notifySpy ? {
				type: "update",
				object: instance,
				oldValue: (observable as any).value,
				name, newValue
			} : null;

		if (notifySpy)
			spyReportStart(change);
		observable.setNewValue(newValue);
		if (notify)
			notifyListeners(adm, change);
		if (notifySpy)
			spyReportEnd();
	}
}

function notifyPropertyAddition(adm, object, name: string, newValue) {
	const notify = hasListeners(adm);
	const notifySpy = isSpyEnabled();
	const change = notify || notifySpy ? {
			type: "add",
			object, name, newValue
		} : null;

	if (notifySpy)
		spyReportStart(change);
	if (notify)
		notifyListeners(adm, change);
	if (notifySpy)
		spyReportEnd();
}

const isObservableObjectAdministration = createInstanceofPredicate("ObservableObjectAdministration", ObservableObjectAdministration);

export function isObservableObject(thing: any): thing is IObservableObject {
	if (isObject(thing)) {
		// Initializers run lazily when transpiling to babel, so make sure they are run...
		runLazyInitializers(thing);
		return isObservableObjectAdministration((thing as any).$mobx);
	}
	return false;
}
